/**
 * Request identity and access logging.
 *
 * Why a request ID:
 *   When a user reports "it failed at 3:14pm", you need to find the one request
 *   among thousands. Every log line emitted while handling a request carries the
 *   same `requestId`, and the ID is returned to the client in the
 *   `X-Request-Id` header and inside every error body. The user can paste the ID
 *   and you can retrieve the complete server-side story of that one request.
 *
 *   We honour an inbound `X-Request-Id` when present so a trace can be followed
 *   across services or from a frontend that generates its own.
 *
 * Why `req.log` (a child logger):
 *   `logger.child({ requestId })` returns a logger that stamps that field onto
 *   every line automatically. Handlers call `req.log.info(...)` and correlation
 *   is free — nobody has to remember to pass the ID around.
 *
 * Why log on 'finish' rather than at the start:
 *   One line per request, emitted when the response completes, carrying the
 *   status and the duration. Logging on entry doubles log volume and still
 *   cannot tell you the outcome. `res.on("finish")` fires once the response has
 *   been flushed, which is exactly when status and latency are known.
 */
import { randomUUID } from "node:crypto";
import logger from "../lib/logger.js";

export function requestContext(req, res, next) {
  const inbound = req.get("x-request-id");
  // Never trust client input verbatim into logs: bound the length and charset
  // so a malicious header cannot inject newlines and forge log entries.
  req.id =
    inbound && /^[\w-]{1,64}$/.test(inbound) ? inbound : randomUUID();

  res.setHeader("X-Request-Id", req.id);
  req.log = logger.child({ requestId: req.id });

  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    // 5xx is our fault, 4xx is the caller's: log them at different levels so
    // alerting can key on `level >= error` without drowning in 404s.
    const level = res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";

    req.log[level](
      {
        method: req.method,
        // req.originalUrl keeps the mount prefix; strip the query string so
        // tokens or search terms in the URL never land in logs.
        path: req.originalUrl.split("?")[0],
        status: res.statusCode,
        durationMs: Number(durationMs.toFixed(1)),
        userId: req.user?.id,
      },
      "request"
    );
  });

  next();
}

export default requestContext;
