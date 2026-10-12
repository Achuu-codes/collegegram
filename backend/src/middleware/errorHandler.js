/**
 * Centralized error handling — the single place where an exception becomes an
 * HTTP response.
 *
 * Why centralize:
 *   The alternative is a try/catch in every controller, each inventing its own
 *   status code and body shape. Clients then cannot handle errors generically,
 *   and one forgotten catch leaks a stack trace. Here, one function decides the
 *   response shape for the entire API, and controllers simply `throw`.
 *
 * Express 5 note worth understanding (this is library behaviour you should be
 * able to explain rather than take on faith):
 *   In Express 4, an exception thrown inside an *async* handler was lost —
 *   the returned promise rejected, nobody awaited it, and the request hung until
 *   it timed out. Every project worked around it with a `catchAsync` wrapper.
 *   Express 5 awaits handler promises and routes rejections to this middleware
 *   automatically, which is why no wrapper appears anywhere in this codebase.
 *
 * The security rule:
 *   Operational errors (AppError) carry messages written to be read by a client.
 *   Everything else is a bug, and a bug's message may contain file paths, SQL,
 *   or internal identifiers. Those are logged in full server-side and replaced
 *   with a generic message in the response. The requestId is the bridge: the
 *   client gets an opaque ID, and we can find the full detail in the logs.
 */
import mongoose from "mongoose";
import { AppError } from "../lib/errors.js";
import config from "../config/index.js";

/**
 * Translate known third-party error shapes into our taxonomy.
 * @returns {{statusCode:number, code:string, message:string, details?:unknown}}
 */
function classify(err) {
  if (err instanceof AppError) {
    return {
      statusCode: err.statusCode,
      code: err.code,
      message: err.message,
      details: err.details,
    };
  }

  // Duplicate key against a unique index. This is how we enforce "one vote per
  // user per post" and "email is unique", so it is an *expected* path, not a
  // bug — see docs/CONCURRENCY.md.
  if (err?.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {})[0] ?? "field";
    return {
      statusCode: 409,
      code: "DUPLICATE_KEY",
      message: `A record with that ${field} already exists`,
      details: { field },
    };
  }

  // A malformed ObjectId in the URL: "/posts/banana".
  if (err instanceof mongoose.Error.CastError) {
    return {
      statusCode: 400,
      code: "INVALID_ID",
      message: `Invalid value for '${err.path}'`,
    };
  }

  if (err instanceof mongoose.Error.ValidationError) {
    return {
      statusCode: 400,
      code: "VALIDATION_FAILED",
      message: "Request validation failed",
      details: Object.values(err.errors).map((e) => ({
        field: e.path,
        message: e.message,
      })),
    };
  }

  // Raised by express.json() — note `type` is the reliable discriminator.
  if (err?.type === "entity.too.large") {
    return {
      statusCode: 413,
      code: "PAYLOAD_TOO_LARGE",
      message: "Request payload too large",
    };
  }
  if (err?.type === "entity.parse.failed") {
    return {
      statusCode: 400,
      code: "MALFORMED_JSON",
      message: "Request body is not valid JSON",
    };
  }

  // Unrecognized: treat as a bug.
  return {
    statusCode: 500,
    code: "INTERNAL_ERROR",
    message: "An unexpected error occurred",
  };
}

// eslint-disable-next-line no-unused-vars -- Express identifies error middleware by arity (4 params)
export function errorHandler(err, req, res, next) {
  const { statusCode, code, message, details } = classify(err);
  const isBug = statusCode >= 500;

  // Log the *original* error, with its stack, regardless of what we return.
  req.log?.[isBug ? "error" : "warn"](
    { err, code, statusCode, path: req.originalUrl?.split("?")[0] },
    isBug ? "unhandled error" : "request failed"
  );

  if (err?.retryAfterSeconds) res.setHeader("Retry-After", err.retryAfterSeconds);

  res.status(statusCode).json({
    error: {
      code,
      message,
      ...(details !== undefined && { details }),
      requestId: req.id,
      // Stacks are a development affordance only. Shipping them to production
      // clients hands an attacker a map of the codebase.
      ...(!config.isProduction && isBug && { stack: err?.stack }),
    },
  });
}

/** Terminal 404 for unmatched routes, so clients get our error shape, not Express's HTML. */
export function notFoundHandler(req, res) {
  res.status(404).json({
    error: {
      code: "ROUTE_NOT_FOUND",
      message: `Cannot ${req.method} ${req.originalUrl.split("?")[0]}`,
      requestId: req.id,
    },
  });
}
