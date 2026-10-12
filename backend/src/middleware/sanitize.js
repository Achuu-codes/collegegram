/**
 * NoSQL operator injection — defence in depth.
 *
 * The attack:
 *   MongoDB queries are documents, and any key beginning with `$` is an
 *   operator. If a user-supplied value reaches a query unchecked, the attacker
 *   controls query *structure*, not just data:
 *
 *       POST /auth/login  {"email": {"$ne": null}, "password": {"$ne": null}}
 *
 *   A naive `User.findOne({ email, password })` then matches the first user in
 *   the collection. The `$where` and `$function` operators go further and
 *   execute JavaScript on the database server.
 *
 *   The second vector is `__proto__` / `constructor` / `prototype` as keys.
 *   JSON.parse itself is safe, but any code that deep-merges parsed input into
 *   an object can walk into Object.prototype and poison every object in the
 *   process (prototype pollution).
 *
 * Why this exists when Zod already blocks it:
 *   Zod is the real fix — `z.string()` rejects `{"$ne": null}` structurally, and
 *   unknown keys are stripped. This middleware is a second layer for the case
 *   where someone later adds a route and forgets the schema. Defence in depth
 *   means a single omission is not a breach.
 *
 * Why we reject rather than silently strip:
 *   A stripped key changes the meaning of the request without telling anyone.
 *   No legitimate client sends a `$`-prefixed key, so a 400 is both honest and a
 *   useful signal that something hostile is happening.
 */
import { ValidationError } from "../lib/errors.js";

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_DEPTH = 12; // bounds recursion against a deliberately nested payload

function scan(value, depth, path) {
  if (depth > MAX_DEPTH) {
    throw new ValidationError("Request payload is too deeply nested");
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => scan(item, depth + 1, `${path}[${i}]`));
    return;
  }
  if (value === null || typeof value !== "object") return;

  for (const key of Object.keys(value)) {
    if (key.startsWith("$") || FORBIDDEN_KEYS.has(key)) {
      throw new ValidationError("Request contains a disallowed key", [
        { field: path ? `${path}.${key}` : key, message: "Keys may not start with '$' or modify the prototype" },
      ]);
    }
    scan(value[key], depth + 1, path ? `${path}.${key}` : key);
  }
}

export function sanitize(req, _res, next) {
  try {
    scan(req.body, 0, "body");
    scan(req.params, 0, "params");
    scan(req.query, 0, "query");
    next();
  } catch (err) {
    next(err);
  }
}

export default sanitize;
