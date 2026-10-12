/**
 * Error taxonomy.
 *
 * The problem this solves:
 *   Without a shared error type, every controller invents its own failure
 *   response — some `res.status(400).json({error})`, some `res.send("not
 *   found")`, some throw a raw Error that becomes a 500 with a stack trace in
 *   the body. Clients then cannot handle errors programmatically, and stack
 *   traces leak internals to attackers.
 *
 * The design:
 *   One base class, `AppError`, carrying everything the central error handler
 *   needs: an HTTP status, a stable machine-readable `code`, a human message
 *   that is safe to show a client, and optional structured `details`.
 *
 *   `isOperational` is the important distinction. An operational error is an
 *   expected failure mode of a correct program: bad input, wrong password,
 *   missing document. A non-operational error is a bug: `undefined is not a
 *   function`. Operational errors are reported to the client as-is; bugs are
 *   logged in full and reported as a generic 500, because their messages may
 *   contain internals and are never actionable for the caller.
 *
 * `code` is deliberately a stable string, not a number. Clients branch on
 * `error.code === "EMAIL_TAKEN"`, which survives refactors and reads clearly in
 * frontend code and tests.
 */

export class AppError extends Error {
  /**
   * @param {object}  opts
   * @param {number}  opts.statusCode  HTTP status to return
   * @param {string}  opts.code        stable machine-readable identifier
   * @param {string}  opts.message     client-safe description
   * @param {unknown} [opts.details]   structured extra context (e.g. field errors)
   * @param {Error}   [opts.cause]     underlying error, logged but never returned
   */
  constructor({ statusCode, code, message, details, cause }) {
    super(message, { cause });
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class ValidationError extends AppError {
  constructor(message = "Request validation failed", details) {
    super({ statusCode: 400, code: "VALIDATION_FAILED", message, details });
  }
}

/** 401: we do not know who you are (missing/invalid/expired credentials). */
export class AuthenticationError extends AppError {
  constructor(message = "Authentication required", code = "UNAUTHENTICATED") {
    super({ statusCode: 401, code, message });
  }
}

/** 403: we know who you are, and you may not do this. */
export class AuthorizationError extends AppError {
  constructor(message = "You do not have permission to perform this action") {
    super({ statusCode: 403, code: "FORBIDDEN", message });
  }
}

export class NotFoundError extends AppError {
  constructor(resource = "Resource") {
    super({ statusCode: 404, code: "NOT_FOUND", message: `${resource} not found` });
  }
}

/** 409: the request is valid but conflicts with current state (duplicate key, version clash). */
export class ConflictError extends AppError {
  constructor(message = "Resource conflict", code = "CONFLICT", details) {
    super({ statusCode: 409, code, message, details });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = "Request payload too large") {
    super({ statusCode: 413, code: "PAYLOAD_TOO_LARGE", message });
  }
}

export class RateLimitError extends AppError {
  constructor(retryAfterSeconds, message = "Too many requests") {
    super({
      statusCode: 429,
      code: "RATE_LIMITED",
      message,
      details: { retryAfterSeconds },
    });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 503: a dependency we need for *this* request is unavailable. */
export class ServiceUnavailableError extends AppError {
  constructor(message = "Service temporarily unavailable", cause) {
    super({ statusCode: 503, code: "SERVICE_UNAVAILABLE", message, cause });
  }
}
