/**
 * Redis connection and the cache-failure policy.
 *
 * THE CENTRAL RULE OF THIS FILE:
 *   Redis is an optimization, never a source of truth. If Redis is down, every
 *   request must still succeed by falling through to MongoDB — slower, but
 *   correct. A cache outage must never become an application outage.
 *
 * Two configuration choices enforce that, and both are easy to get wrong:
 *
 *   `enableOfflineQueue: false`
 *       By default ioredis *queues* commands issued while disconnected and
 *       replays them on reconnect. For a cache that is the worst possible
 *       behaviour: instead of a fast failure that we can treat as a cache miss,
 *       every request hangs waiting for a Redis that may never come back, and
 *       the queue grows until the process runs out of memory. With the queue
 *       disabled, commands reject immediately and we fall through to Mongo.
 *
 *   `maxRetriesPerRequest: 1`
 *       Bounds how long a single command can stall before it gives up.
 *
 * Every call site must therefore tolerate a rejection. Rather than trusting
 * fifteen future call sites to remember a try/catch, the `cache` helper at the
 * bottom of this file does it once: a Redis failure is converted into "cache
 * miss" (`null`) and logged at warn level. Code that needs Redis to *succeed*
 * (the rate limiter, which must fail closed-ish) talks to the client directly
 * and handles its own errors explicitly.
 */
import Redis from "ioredis";
import config from "../config/index.js";
import logger from "./logger.js";

/** @type {Redis | null} */
let client = null;
let ready = false;

export function createRedisClient() {
  const redis = new Redis(config.redis.url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 3_000,
    // Exponential-ish backoff, capped, so a long outage does not become a
    // reconnect storm against a recovering server.
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });

  redis.on("ready", () => {
    ready = true;
    logger.info("redis ready");
  });
  redis.on("end", () => {
    ready = false;
    logger.warn("redis connection closed");
  });
  // Without an 'error' listener, ioredis emits an unhandled 'error' event and
  // Node crashes the process — the exact opposite of degrading gracefully.
  redis.on("error", (err) => {
    ready = false;
    logger.warn({ err: err.message }, "redis error (continuing without cache)");
  });

  return redis;
}

/**
 * Connect at boot. Unlike Mongo, a failure here is NOT fatal: we log it and
 * start anyway, because the application is fully functional without a cache.
 */
export async function connectRedis() {
  client = createRedisClient();
  try {
    await client.connect();
  } catch (err) {
    logger.warn({ err: err.message }, "redis unavailable at boot; running without cache");
  }
  return client;
}

export async function disconnectRedis() {
  if (!client) return;
  try {
    await client.quit(); // graceful: finishes in-flight commands
  } catch {
    client.disconnect(); // forceful fallback
  }
  client = null;
  ready = false;
  logger.info("redis connection closed");
}

export const getRedis = () => client;
export const isRedisHealthy = () => ready && client?.status === "ready";

/** Allows tests to inject a stub or a deliberately broken client. */
export function setRedisClientForTests(stub) {
  client = stub;
  ready = Boolean(stub);
}

/**
 * Failure-tolerant cache facade. Every method treats a Redis problem as a miss.
 */
export const cache = {
  /** @returns {Promise<any|null>} parsed value, or null on miss OR failure */
  async get(key) {
    if (!isRedisHealthy()) return null;
    try {
      const raw = await client.get(key);
      return raw === null ? null : JSON.parse(raw);
    } catch (err) {
      logger.warn({ err: err.message, key }, "cache get failed; treating as miss");
      return null;
    }
  },

  /** Fire-and-forget write. A failed cache write must not fail the request. */
  async set(key, value, ttlSeconds) {
    if (!isRedisHealthy()) return false;
    try {
      await client.set(key, JSON.stringify(value), "EX", ttlSeconds);
      return true;
    } catch (err) {
      logger.warn({ err: err.message, key }, "cache set failed");
      return false;
    }
  },

  async del(...keys) {
    if (!isRedisHealthy() || keys.length === 0) return false;
    try {
      await client.del(...keys);
      return true;
    } catch (err) {
      logger.warn({ err: err.message, keys }, "cache del failed");
      return false;
    }
  },
};

export default cache;
