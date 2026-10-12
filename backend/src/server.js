/**
 * Process entry point: boot order, and shutdown order.
 *
 * BOOT ORDER matters. We connect to MongoDB *before* calling listen(). If we
 * listened first, there would be a window where the port is open and the load
 * balancer is routing real traffic to an instance with no database, producing a
 * burst of 500s on every deploy. Connect first, then open the door.
 *
 * Redis is the opposite: its failure is non-fatal, so a boot failure is logged
 * and we continue without a cache.
 *
 * GRACEFUL SHUTDOWN — what SIGTERM actually means and why this code exists:
 *   When a deploy replaces this process (or Ctrl-C, or a container eviction),
 *   the supervisor sends SIGTERM and then, after a grace period, SIGKILL.
 *   Node's default SIGTERM behaviour is to exit *immediately*, which kills
 *   in-flight requests mid-response: users see connection resets, and a write
 *   that was half-applied is simply abandoned.
 *
 *   The correct sequence, implemented below:
 *     1. Stop accepting new connections (server.close) while letting in-flight
 *        requests run to completion.
 *     2. Close the database and cache connections once nothing is using them,
 *        so the server does not log connection-reset errors on our behalf.
 *     3. Exit 0.
 *
 *   The timeout is the essential safety valve: if a request hangs forever, we
 *   must not hang forever with it, or the supervisor's SIGKILL does the ugly
 *   version of this anyway. We force-exit after SHUTDOWN_TIMEOUT_MS.
 */
import config from "./config/index.js";
import logger from "./lib/logger.js";
import { createApp } from "./app.js";
import { connectMongo, disconnectMongo } from "./lib/mongo.js";
import { connectRedis, disconnectRedis } from "./lib/redis.js";

async function start() {
  await connectMongo(); // fatal if it fails — see catch at the bottom
  await connectRedis(); // non-fatal by design

  const app = createApp();
  const server = app.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env }, "http server listening");
  });

  // Node's default keep-alive timeout (5s) must exceed the upstream proxy's, or
  // the proxy can reuse a socket at the exact moment Node closes it, producing
  // sporadic, hard-to-reproduce 502s. Setting ours higher avoids that race.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let shuttingDown = false;

  async function shutdown(signal) {
    // A second Ctrl-C should not start a second shutdown.
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "shutdown initiated");

    const forceExit = setTimeout(() => {
      logger.error("graceful shutdown timed out; forcing exit");
      process.exit(1);
    }, config.http.shutdownTimeoutMs);
    forceExit.unref(); // this timer must not itself keep the process alive

    try {
      await new Promise((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      );
      logger.info("http server closed to new connections");

      await Promise.allSettled([disconnectMongo(), disconnectRedis()]);

      clearTimeout(forceExit);
      logger.info("shutdown complete");
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "error during shutdown");
      process.exit(1);
    }
  }

  process.on("SIGTERM", () => shutdown("SIGTERM")); // orchestrator / deploy
  process.on("SIGINT", () => shutdown("SIGINT")); // Ctrl-C

  /**
   * An uncaught exception means the process is in an unknown state: a stack was
   * unwound past every handler, so invariants may be broken and memory may hold
   * half-written data. The only safe response is to log loudly and restart.
   * Deliberately NOT "log it and keep serving" — that is how corrupt state gets
   * written to the database for hours before anyone notices.
   */
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaught exception");
    shutdown("uncaughtException").finally(() => process.exit(1));
  });

  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandled promise rejection");
    shutdown("unhandledRejection").finally(() => process.exit(1));
  });

  return server;
}

start().catch((err) => {
  logger.fatal({ err }, "failed to start");
  process.exit(1);
});
