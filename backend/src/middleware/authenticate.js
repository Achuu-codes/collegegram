/**
 * Authentication and authorization middleware.
 *
 * THE DISTINCTION, because interviewers ask it and the two are routinely
 * conflated:
 *   Authentication = "who are you?"   → produces req.user, fails with 401.
 *   Authorization  = "may you do this?" → inspects req.user, fails with 403.
 *
 * A 401 means "I do not know you; present credentials." A 403 means "I know
 * exactly who you are, and the answer is still no." Returning 401 for an
 * authorization failure is a common bug that makes well-behaved clients
 * pointlessly try to re-authenticate.
 *
 * WHY `authenticate` DOES NOT HIT THE DATABASE
 *   The access token is signed, so its claims (user id, role) are trustworthy
 *   without a lookup. Verifying a JWT is one HMAC — microseconds — while a
 *   user lookup would add a database round trip to EVERY authenticated request
 *   in the system. That is the entire performance argument for stateless
 *   tokens, and giving it up by default would be self-defeating.
 *
 *   The cost is staleness, and it must be stated honestly: if a user is
 *   suspended or demoted, their existing access token keeps working until it
 *   expires — up to 15 minutes. We accept that bounded window. Routes where
 *   that is unacceptable (destructive admin actions) can load the user
 *   explicitly; `requireFreshUser` below does exactly that.
 */
import { verifyAccessToken } from "../modules/auth/token.service.js";
import { AuthenticationError, AuthorizationError } from "../lib/errors.js";
import { User } from "../modules/user/user.model.js";

/** Pull a bearer token out of the Authorization header. */
function extractToken(req) {
  const header = req.get("authorization");
  if (!header) return null;
  // Case-insensitive scheme, exactly one space, non-empty credential.
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  return match ? match[1] : null;
}

/** Hard requirement: 401 if there is no valid access token. */
export function authenticate(req, _res, next) {
  const token = extractToken(req);
  if (!token) {
    next(new AuthenticationError("Authentication required", "TOKEN_MISSING"));
    return;
  }

  try {
    const { userId, role } = verifyAccessToken(token);
    req.user = { id: userId, role };
    // Re-bind the request logger so every subsequent log line in this request
    // carries the user id without anyone passing it around.
    req.log = req.log.child({ userId });
    next();
  } catch (err) {
    next(err); // already an AuthenticationError with TOKEN_EXPIRED / TOKEN_INVALID
  }
}

/**
 * Soft authentication: populates req.user when a valid token is present and
 * continues anonymously otherwise.
 *
 * Needed for endpoints whose *response* differs by viewer but which are public:
 * the feed shows "did I vote on this?" to a signed-in user and omits it for a
 * guest. Without this, the frontend would need two different endpoints.
 *
 * An INVALID token is ignored rather than rejected here — the caller asked for
 * public data and will simply receive the anonymous view.
 */
export function optionalAuth(req, _res, next) {
  const token = extractToken(req);
  if (!token) return next();

  try {
    const { userId, role } = verifyAccessToken(token);
    req.user = { id: userId, role };
    req.log = req.log.child({ userId });
  } catch {
    // Deliberately ignored: treat as anonymous.
  }
  next();
}

/**
 * Role gate. Usage: router.delete("/:id", authenticate, requireRole("moderator", "admin"), ...)
 *
 * Roles here are coarse and global. Per-resource permission ("is this YOUR
 * post?") is ownership, which cannot be answered from the token because it
 * depends on the stored document — that check lives in the service layer where
 * the resource is loaded. See docs/AUTHORIZATION.md.
 */
export function requireRole(...allowedRoles) {
  return (req, _res, next) => {
    if (!req.user) {
      next(new AuthenticationError("Authentication required", "TOKEN_MISSING"));
      return;
    }
    if (!allowedRoles.includes(req.user.role)) {
      next(new AuthorizationError("You do not have permission to perform this action"));
      return;
    }
    next();
  };
}

/**
 * Loads the user from the database and re-checks role and status, eliminating
 * the up-to-15-minute staleness of the token's claims.
 *
 * Deliberately NOT the default: it costs a query per request. Reserve it for
 * actions where acting on a stale role is genuinely dangerous.
 */
export async function requireFreshUser(req, _res, next) {
  try {
    const user = await User.findById(req.user.id).select("role status");
    if (!user || user.status !== "active") {
      throw new AuthorizationError("This account is not active");
    }
    req.user.role = user.role; // authoritative, not the token's copy
    next();
  } catch (err) {
    next(err);
  }
}
