/**
 * Distributed rate limiting, backed by Redis.
 *
 * WHY REDIS RATHER THAN AN IN-MEMORY COUNTER
 *   An in-process Map works perfectly on one server and silently breaks the
 *   moment you run two. With N instances behind a load balancer, each keeps its
 *   own counts, so a limit of 5 becomes an effective 5xN — and it resets on
 *   every deploy. The limit must live somewhere all instances share, and the
 *   operation must be atomic. Redis is single-threaded per command, which makes
 *   it a natural arbiter for exactly this.
 *
 * THE ALGORITHM: fixed window counter
 *   INCR a key named for (scope, identifier) and expire it after the window.
 *   First increment in a window sets the TTL; the key disappears on its own.
 *   O(1) time, one small integer of memory per active client.
 *
 *   ITS KNOWN FLAW, which you should volunteer rather than be caught by: a
 *   client can send `limit` requests at the very end of one window and
 *   `limit` more at the start of the next, achieving 2x the limit across that
 *   boundary. For login throttling this is acceptable — 10 attempts in a
 *   suspicious burst instead of 5 does not meaningfully help an attacker who
 *   needs millions. The alternatives are a sliding-window log (exact, but
 *   stores a timestamp per request — unbounded memory under attack, which is
 *   itself a DoS vector) or a token bucket (smooth, more state). Fixed window
 *   is the right default here; the others are justified if we ever meter
 *   something expensive per-unit.
 *
 * WHY A LUA SCRIPT
 *   The obvious implementation is INCR then, if the result is 1, EXPIRE. Those
 *   are two round trips, and if the process dies or Redis fails between them
 *   the key has NO TTL — it lives forever, and that client is rate-limited
 *   permanently. Redis runs a Lua script atomically as a single operation, so
 *   the increment and the expiry cannot be separated.
 *
 * FAILURE POLICY: FAIL OPEN
 *   If Redis is unreachable we allow the request and log a warning. This is a
 *   real security decision with a real cost, so here is the reasoning: failing
 *   closed would mean a Redis outage takes down login for everyone — a
 *   guaranteed, total, self-inflicted outage — in order to prevent a brute
 *   force that is merely possible during that window. Brute force is still
 *   bounded by bcrypt's cost and by monitoring. Availability wins. For a
 *   payment or password-reset endpoint the calculus could flip, and that would
 *   be a per-route decision.
 */
import { getRedis, isRedisHealthy } from "../lib/redis.js";
import { RateLimitError } from "../lib/errors.js";

/**
 * KEYS[1] = counter key, ARGV[1] = window seconds.
 * Returns { count, ttl }.
 */
const FIXED_WINDOW_SCRIPT = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
  end
  return { count, redis.call('TTL', KEYS[1]) }
`;

/**
 * @param {object} options
 * @param {string} options.scope            namespace, e.g. "login"
 * @param {number} options.limit            allowed requests per window
 * @param {number} options.windowSeconds
 * @param {(req) => string[]} [options.keys] identifiers to meter independently
 */
export function rateLimit({ scope, limit, windowSeconds, keys }) {
  // Default: meter by client IP.
  const resolveKeys = keys ?? ((req) => [`ip:${req.ip}`]);

  return async function rateLimitMiddleware(req, res, next) {
    if (!isRedisHealthy()) {
      req.log.warn({ scope }, "rate limiting unavailable (redis down); allowing request");
      return next();
    }

    try {
      const identifiers = resolveKeys(req).filter(Boolean);
      const redis = getRedis();

      // Each identifier is metered separately, and the strictest result wins.
      // Login uses two: per-IP (stops one host hammering many accounts) and
      // per-account (stops a botnet spread across thousands of IPs hammering
      // ONE account, which a per-IP limit alone cannot see).
      const results = await Promise.all(
        identifiers.map((id) =>
          redis.eval(FIXED_WINDOW_SCRIPT, 1, `cg:rl:${scope}:${id}`, windowSeconds)
        )
      );

      const exceeded = results.find(([count]) => count > limit);

      // Report remaining budget against the most-consumed identifier.
      const highest = Math.max(...results.map(([count]) => count));
      res.setHeader("X-RateLimit-Limit", limit);
      res.setHeader("X-RateLimit-Remaining", Math.max(0, limit - highest));

      if (exceeded) {
        const retryAfter = exceeded[1] > 0 ? exceeded[1] : windowSeconds;
        req.log.warn({ scope, ip: req.ip, retryAfter }, "rate limit exceeded");
        // 429 + Retry-After tells a well-behaved client exactly when to come
        // back, instead of leaving it to guess and hammer.
        throw new RateLimitError(retryAfter);
      }

      next();
    } catch (err) {
      if (err instanceof RateLimitError) return next(err);
      // Any OTHER error here is a Redis problem: fail open, as argued above.
      req.log.warn({ err: err.message, scope }, "rate limiter error; allowing request");
      next();
    }
  };
}

export default rateLimit;
