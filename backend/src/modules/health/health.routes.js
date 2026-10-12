/**
 * Health endpoints.
 *
 * Two endpoints, because "is it healthy?" is really two different questions and
 * conflating them causes outages:
 *
 *   GET /health        LIVENESS  — "is this process alive?"
 *       Answers 200 as long as the event loop is turning. It must NOT check
 *       dependencies. Here is why that matters: an orchestrator restarts a
 *       container that fails its liveness probe. If liveness checked MongoDB,
 *       then a database blip would fail the probe on every instance at once and
 *       the orchestrator would restart the entire fleet — turning a recoverable
 *       database hiccup into a total outage, and adding a thundering herd of
 *       reconnections to a database that is already struggling.
 *
 *   GET /health/ready  READINESS — "should this instance receive traffic?"
 *       Checks dependencies and returns 503 when the instance cannot serve
 *       correctly. A load balancer removes it from rotation but does not kill
 *       it, so it can recover and rejoin.
 *
 * The Redis asymmetry is the interesting design decision here. MongoDB being
 * down makes us unready: nothing works without it. Redis being down does NOT,
 * because every cache path falls through to MongoDB (see lib/redis.js). We
 * report Redis as "degraded" in the body and stay in rotation. Serving slowly
 * is strictly better than serving nothing.
 *
 * Information disclosure: the body reports dependency up/down and nothing else
 * — no versions, no hostnames, no connection strings, no error text. An
 * unauthenticated endpoint should never help an attacker fingerprint the stack.
 */
import { Router } from "express";
import { isMongoHealthy, pingMongo } from "../../lib/mongo.js";
import { isRedisHealthy, getRedis } from "../../lib/redis.js";

const router = Router();
const startedAt = Date.now();

router.get("/", (_req, res) => {
  res.json({
    data: {
      status: "ok",
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    },
  });
});

router.get("/ready", async (req, res) => {
  // Bound each check: a readiness probe that hangs is itself an outage, because
  // the load balancer cannot tell "slow" from "dead".
  const withTimeout = (promise, ms) =>
    Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
    ]);

  const checks = { mongo: "down", redis: "down" };

  try {
    if (isMongoHealthy()) {
      await withTimeout(pingMongo(), 1_000);
      checks.mongo = "up";
    }
  } catch (err) {
    req.log.warn({ err: err.message }, "readiness: mongo check failed");
  }

  try {
    if (isRedisHealthy()) {
      await withTimeout(getRedis().ping(), 1_000);
      checks.redis = "up";
    }
  } catch (err) {
    req.log.warn({ err: err.message }, "readiness: redis check failed");
  }

  // Only MongoDB gates readiness. Redis down = degraded, still serving.
  const ready = checks.mongo === "up";
  const status = !ready ? "unavailable" : checks.redis === "up" ? "ok" : "degraded";

  res.status(ready ? 200 : 503).json({ data: { status, checks } });
});

export default router;
