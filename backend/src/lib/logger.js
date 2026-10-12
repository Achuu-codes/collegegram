/**
 * Structured logging.
 *
 * Why structured (JSON) rather than console.log string interpolation:
 *   A log line is only useful if you can search it. `console.log("user " + id +
 *   " logged in")` produces text a human can read and a machine cannot filter.
 *   A JSON line {"msg":"login","userId":"..."} can be queried by field in any
 *   log aggregator. In development we pipe it through pino-pretty so it is still
 *   readable by a human.
 *
 * Redaction:
 *   The `redact` list below is a safety net, not a licence to log secrets. We
 *   never deliberately log a password, token or cookie — but a future `log.info({
 *   req })` by an unwary hand should not leak the Authorization header, so the
 *   paths are censored at the logger level where it cannot be forgotten.
 */
import pino from "pino";
import config from "../config/index.js";

export const logger = pino({
  level: config.logLevel,
  base: undefined, // drop pid/hostname noise; add them back if we ever run multi-host
  redact: {
    paths: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers['set-cookie']",
      "password",
      "passwordHash",
      "*.password",
      "*.passwordHash",
      "accessToken",
      "refreshToken",
      "*.accessToken",
      "*.refreshToken",
    ],
    censor: "[redacted]",
  },
  transport: config.isProduction
    ? undefined // raw JSON to stdout; the platform collects it
    : { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss.l", ignore: "pid,hostname" } },
});

export default logger;
