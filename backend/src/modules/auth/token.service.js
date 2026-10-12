/**
 * JWT minting and verification.
 *
 * WHAT A JWT ACTUALLY IS (the thing to be able to explain without hand-waving)
 *   Three base64url segments joined by dots: `header.payload.signature`.
 *   The header names the algorithm, the payload is JSON claims, and the
 *   signature is HMAC-SHA256(header + "." + payload, secret).
 *
 *   The payload is ENCODED, NOT ENCRYPTED. Anyone holding the token can read
 *   its contents — paste one into jwt.io and the claims are right there. So a
 *   JWT may never contain anything secret: no password hash, no email, no
 *   personal data. Ours carries a user id, a role, and timestamps.
 *
 *   What the signature buys is integrity: without the secret you cannot alter
 *   `role: "user"` to `role: "admin"` and produce a matching signature. That
 *   is the entire security model, and it is why the secret leaking is
 *   equivalent to every account being compromised.
 *
 * WHY TWO TOKEN TYPES
 *   They solve opposing problems and cannot be one token.
 *
 *   The access token is stateless: we verify the signature and trust the
 *   claims, with no database lookup. That is what makes authenticated requests
 *   cheap. But the same property means it CANNOT BE REVOKED before it expires
 *   — there is nothing to delete. So it must be short-lived (15 min), which
 *   bounds the damage of a stolen one.
 *
 *   The refresh token is stateful: it is backed by a Session row, so it can be
 *   revoked instantly, and it can be long-lived (30 days) because of that. It
 *   is used rarely (once per access-token expiry) and is scoped to the
 *   /auth path by the cookie, so it is not sent on ordinary API calls.
 *
 *   Net effect: the user stays logged in for 30 days, but the credential that
 *   travels on every single request is worthless 15 minutes after theft.
 *
 * WHY SEPARATE SECRETS, AND WHY A `type` CLAIM
 *   Signing both with one key would let a stolen access token be replayed as a
 *   refresh token. Separate keys make that structurally impossible. The `type`
 *   claim is checked anyway as defence in depth: cheap, and it fails loudly if
 *   the two secrets are ever misconfigured to the same value.
 *
 * `alg: "none"` — the classic JWT attack:
 *   Early libraries honoured the *token's own* header when choosing a
 *   verification algorithm, so an attacker could set `alg: "none"`, strip the
 *   signature, and be believed. We pass `algorithms: ["HS256"]` explicitly on
 *   every verify, which pins the algorithm server-side and makes the header's
 *   claim irrelevant.
 */
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import config from "../../config/index.js";
import { AuthenticationError } from "../../lib/errors.js";

const ALGORITHM = "HS256";
const TOKEN_TYPE = Object.freeze({ ACCESS: "access", REFRESH: "refresh" });

export { TOKEN_TYPE };

/**
 * @param {{ id: string, role: string }} user
 * @returns {string} signed access token
 */
export function signAccessToken(user) {
  return jwt.sign(
    { type: TOKEN_TYPE.ACCESS, role: user.role },
    config.auth.accessSecret,
    {
      algorithm: ALGORITHM,
      subject: String(user.id),
      issuer: config.auth.issuer,
      expiresIn: config.auth.accessTtlSeconds,
    }
  );
}

/**
 * @param {{ userId: string, familyId: string }} params
 * @returns {{ token: string, jti: string, expiresAt: Date }}
 */
export function signRefreshToken({ userId, familyId }) {
  // A fresh random id per token. This is the handle the Session row stores and
  // the thing that rotation swaps.
  const jti = randomUUID();

  const token = jwt.sign(
    { type: TOKEN_TYPE.REFRESH, fid: familyId },
    config.auth.refreshSecret,
    {
      algorithm: ALGORITHM,
      subject: String(userId),
      issuer: config.auth.issuer,
      expiresIn: config.auth.refreshTtlSeconds,
      jwtid: jti,
    }
  );

  return {
    token,
    jti,
    expiresAt: new Date(Date.now() + config.auth.refreshTtlSeconds * 1000),
  };
}

/**
 * Verify and decode, translating jsonwebtoken's error types into our taxonomy.
 *
 * The expired/invalid distinction is deliberate and is consumed by the client:
 * TOKEN_EXPIRED tells the frontend "call /auth/refresh and retry", while
 * TOKEN_INVALID means "this is garbage, send the user to the login screen".
 * Collapsing both into a generic 401 would make a silent refresh impossible.
 */
function verify(token, secret, expectedType) {
  let payload;
  try {
    payload = jwt.verify(token, secret, {
      algorithms: [ALGORITHM], // pinned server-side; see `alg: "none"` above
      issuer: config.auth.issuer,
    });
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      throw new AuthenticationError("Token has expired", "TOKEN_EXPIRED");
    }
    throw new AuthenticationError("Invalid token", "TOKEN_INVALID");
  }

  if (payload.type !== expectedType) {
    throw new AuthenticationError("Invalid token", "TOKEN_INVALID");
  }

  return payload;
}

/** @returns {{ userId: string, role: string }} */
export function verifyAccessToken(token) {
  const payload = verify(token, config.auth.accessSecret, TOKEN_TYPE.ACCESS);
  return { userId: payload.sub, role: payload.role };
}

/** @returns {{ userId: string, jti: string, familyId: string }} */
export function verifyRefreshToken(token) {
  const payload = verify(token, config.auth.refreshSecret, TOKEN_TYPE.REFRESH);
  return { userId: payload.sub, jti: payload.jti, familyId: payload.fid };
}

/**
 * Cookie attributes for the refresh token. Each one blocks a specific attack:
 *
 *   httpOnly   JavaScript cannot read it. An XSS payload can still *use* the
 *              session by making requests, but it cannot exfiltrate the token
 *              for offline reuse. This is the main reason the refresh token is
 *              in a cookie rather than localStorage.
 *   secure     HTTPS only, so it is never sent over plaintext where a network
 *              observer could capture it. Disabled in development because
 *              localhost is http, which is why this is config-driven.
 *   sameSite   'strict' means the browser omits the cookie on any cross-site
 *              request, which is what defeats CSRF: an attacker's page can
 *              trigger a POST to /auth/refresh, but the cookie will not ride
 *              along, so the request is unauthenticated and harmless.
 *   path       Scoped to /auth, so the cookie is not attached to the hundreds
 *              of ordinary API calls that have no use for it. Less exposure,
 *              fewer bytes per request.
 */
export function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "strict",
    path: "/auth",
    maxAge: config.auth.refreshTtlSeconds * 1000,
  };
}

export const REFRESH_COOKIE_NAME = "cg_refresh";
