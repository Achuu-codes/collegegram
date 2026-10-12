/**
 * Schema validation at the HTTP boundary.
 *
 * The principle: every byte that enters the process from outside is untrusted
 * and unvalidated until it passes through here. Controllers below this line may
 * assume their input is well-formed, correctly typed, and bounded in size. That
 * assumption is what keeps controllers short and free of defensive clutter.
 *
 * Three things this buys us beyond "nice error messages":
 *
 *   1. Type coercion at the edge. `?limit=20` arrives as the string "20".
 *      Without coercion, `limit > 100` compares a string to a number and
 *      silently misbehaves. Zod coerces once, here, so the service layer always
 *      receives a real number.
 *
 *   2. Stripping unknown keys. Zod objects drop fields not in the schema by
 *      default. That kills mass-assignment: a POST body containing
 *      {"role":"admin"} or {"score":99999} never reaches the model, because the
 *      schema does not mention those fields so they are removed.
 *
 *   3. NoSQL-injection resistance. MongoDB query operators are objects:
 *      {"email": {"$ne": null}} as a login body would, against a naive
 *      implementation, match the first user in the collection. Declaring
 *      `email: z.string()` rejects the object outright — a string is required,
 *      an object is not a string. This is the structural fix; see also the
 *      sanitize middleware for defence in depth.
 *
 * We validate `body`, `params` and `query` independently and write the parsed
 * result back, so downstream code sees the cleaned values rather than raw ones.
 */
import { ZodError } from "zod";
import { ValidationError } from "../lib/errors.js";

/** Flatten Zod's issue list into [{ field, message }] for the client. */
const formatIssues = (error) =>
  error.issues.map((issue) => ({
    field: issue.path.join(".") || "(root)",
    message: issue.message,
  }));

/**
 * @param {{ body?: import('zod').ZodTypeAny,
 *           params?: import('zod').ZodTypeAny,
 *           query?: import('zod').ZodTypeAny }} schemas
 */
export function validate(schemas) {
  return (req, _res, next) => {
    try {
      if (schemas.params) req.params = schemas.params.parse(req.params);
      if (schemas.query) {
        // Express 5 makes req.query a getter with no setter, so assigning to it
        // throws. We stash the validated values on a separate property instead.
        req.validatedQuery = schemas.query.parse(req.query);
      }
      if (schemas.body) req.body = schemas.body.parse(req.body ?? {});
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(new ValidationError("Request validation failed", formatIssues(err)));
        return;
      }
      next(err);
    }
  };
}

export default validate;
