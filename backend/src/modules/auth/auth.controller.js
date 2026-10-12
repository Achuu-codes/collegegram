/**
 * HTTP adapter for the auth module.
 *
 * Controllers here do four things and nothing else:
 *   1. pull already-validated input off the request,
 *   2. call a service,
 *   3. translate the result into status code + body (+ cookie),
 *   4. let errors propagate.
 *
 * There is no try/catch anywhere below. Express 5 forwards a rejected promise
 * from an async handler to the error middleware automatically, so catching
 * here would only produce noise. Business rules live in auth.service.js, which
 * is why these functions stay this short.
 *
 * THE TOKEN SPLIT — the reason the response and the cookie carry different
 * things:
 *   The ACCESS token is returned in the JSON body, and the frontend holds it
 *   in a JavaScript variable (memory), never localStorage. Memory dies with
 *   the tab, so there is nothing persistent for an XSS payload to steal later,
 *   and it is attached as an Authorization header where CSRF cannot reach it —
 *   a cross-site form post cannot set custom headers.
 *
 *   The REFRESH token goes into an httpOnly cookie, so JavaScript cannot read
 *   it at all. The browser attaches it automatically, and only to /auth.
 *
 *   Each token therefore sits where its own worst threat cannot reach it:
 *   the long-lived one is out of reach of XSS, and the frequently-sent one is
 *   out of reach of CSRF. Putting both in localStorage, which is the common
 *   shortcut, exposes the 30-day credential to any injected script.
 */
import * as authService from "./auth.service.js";
import { REFRESH_COOKIE_NAME, refreshCookieOptions } from "./token.service.js";

/** Shared request metadata recorded on the session row. */
const contextOf = (req) => ({ userAgent: req.get("user-agent"), ip: req.ip });

function sendTokens(res, statusCode, { user, tokens }) {
  res.cookie(REFRESH_COOKIE_NAME, tokens.refreshToken, refreshCookieOptions());
  res.status(statusCode).json({
    data: {
      user, // toJSON on the model strips passwordHash and __v
      accessToken: tokens.accessToken,
      // Seconds, so the client can schedule a refresh slightly early rather
      // than waiting for a 401 and retrying.
      expiresIn: tokens.expiresIn,
    },
  });
}

/** POST /auth/register → 201 */
export async function register(req, res) {
  const result = await authService.register(req.body, contextOf(req));
  sendTokens(res, 201, result);
}

/** POST /auth/login → 200 */
export async function login(req, res) {
  const result = await authService.login(req.body, contextOf(req));
  sendTokens(res, 200, result);
}

/** POST /auth/refresh → 200. Credentials come from the cookie, not the body. */
export async function refresh(req, res) {
  const result = await authService.refresh(req.cookies?.[REFRESH_COOKIE_NAME], contextOf(req));
  sendTokens(res, 200, result);
}

/**
 * POST /auth/logout → 204
 *
 * Always 204, even if the token was already revoked or absent. The request
 * expresses an intent ("end this session") that is satisfied in every case, so
 * a retry after a dropped connection must not fail. Note that clearCookie must
 * use the SAME attributes the cookie was set with — a mismatched path leaves
 * the browser holding a cookie we believe we deleted.
 */
export async function logout(req, res) {
  await authService.logout(req.cookies?.[REFRESH_COOKIE_NAME]);
  const { maxAge, ...clearOptions } = refreshCookieOptions();
  res.clearCookie(REFRESH_COOKIE_NAME, clearOptions);
  res.status(204).send();
}

/** POST /auth/logout-all → 200. Requires a valid access token. */
export async function logoutAll(req, res) {
  const revoked = await authService.logoutAll(req.user.id);
  const { maxAge, ...clearOptions } = refreshCookieOptions();
  res.clearCookie(REFRESH_COOKIE_NAME, clearOptions);
  res.json({ data: { sessionsRevoked: revoked } });
}

/** GET /auth/me → 200 */
export async function me(req, res) {
  const user = await authService.getCurrentUser(req.user.id);
  res.json({ data: { user } });
}
