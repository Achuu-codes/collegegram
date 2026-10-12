/**
 * Authentication business logic.
 *
 * This layer owns the rules; the controller owns HTTP. Nothing here touches
 * `req` or `res`, which is what makes these functions directly unit-testable
 * and reusable from a future CLI, worker, or seed script.
 */
import { randomUUID } from "node:crypto";
import config from "../../config/index.js";
import logger from "../../lib/logger.js";
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
} from "../../lib/errors.js";
import { User } from "../user/user.model.js";
import { Session } from "./session.model.js";
import { hashPassword, verifyPassword, getDummyHash } from "./password.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "./token.service.js";

/**
 * Create a brand-new session family. Called on login and registration — never
 * on refresh, which rotates within an existing family.
 */
async function startSession(user, context = {}) {
  const familyId = randomUUID();
  const { token: refreshToken, jti, expiresAt } = signRefreshToken({
    userId: user.id,
    familyId,
  });

  await Session.create({
    userId: user._id,
    familyId,
    jti,
    expiresAt,
    userAgent: context.userAgent?.slice(0, 400),
    ip: context.ip,
  });

  return {
    accessToken: signAccessToken(user),
    refreshToken,
    expiresIn: config.auth.accessTtlSeconds,
  };
}

/**
 * Registration.
 *
 * DUPLICATE PREVENTION IS DELEGATED TO THE DATABASE, NOT CHECKED HERE.
 *   The tempting implementation is:
 *       if (await User.findOne({ email })) throw new ConflictError(...)
 *       await User.create({ email, ... })
 *   which is wrong under concurrency. Two simultaneous registrations with the
 *   same email both run findOne, both see nothing, and both insert — two
 *   accounts, one email. The gap between the check and the write is the bug
 *   (time-of-check to time-of-use), and no amount of reordering closes it.
 *
 *   The unique index is the only thing that can decide a winner atomically, so
 *   we simply attempt the insert and translate the resulting E11000 into a 409.
 *   "Try it and handle the failure" beats "look before you leap" whenever the
 *   database can enforce the constraint itself.
 */
export async function register({ email, username, displayName, password }, context) {
  const passwordHash = await hashPassword(password);

  // Derived, not user-supplied: the client cannot claim to be at a college it
  // did not register an email address with.
  const collegeDomain = email.split("@")[1]?.toLowerCase();

  let user;
  try {
    user = await User.create({
      email,
      username,
      displayName,
      passwordHash,
      collegeDomain,
    });
  } catch (err) {
    if (err?.code === 11000) {
      const field = Object.keys(err.keyPattern ?? {})[0];
      // A deliberate, documented tradeoff: telling the caller *which* field
      // collided confirms that an account exists (user enumeration). The
      // alternative — a vague "registration failed" — produces a genuinely
      // terrible signup experience and is defeated anyway by the login form
      // and password reset. We accept the disclosure here and mitigate with
      // rate limiting. See docs/SECURITY.md.
      throw new ConflictError(
        field === "email" ? "An account with that email already exists" : "That username is taken",
        field === "email" ? "EMAIL_TAKEN" : "USERNAME_TAKEN",
        { field }
      );
    }
    throw err;
  }

  logger.info({ userId: user.id }, "user registered");
  return { user, tokens: await startSession(user, context) };
}

/**
 * Login.
 *
 * Note the uniform failure: a missing account and a wrong password produce the
 * identical code, message, status AND roughly the same latency (see the dummy
 * hash in password.js). Any asymmetry — a different message, a faster
 * response — is an oracle that tells an attacker which email addresses are
 * real.
 */
export async function login({ identifier, password }, context) {
  const normalized = identifier.toLowerCase().trim();

  // One query for "email or username" rather than two sequential lookups.
  // Both branches are backed by their own unique index.
  const user = await User.findOne({
    $or: [{ email: normalized }, { username: normalized }],
  }).select("+passwordHash");

  if (!user) {
    // Burn equivalent CPU so the no-such-user path is not measurably faster.
    await verifyPassword(password, await getDummyHash());
    throw new AuthenticationError("Invalid credentials", "INVALID_CREDENTIALS");
  }

  const passwordMatches = await verifyPassword(password, user.passwordHash);
  if (!passwordMatches) {
    throw new AuthenticationError("Invalid credentials", "INVALID_CREDENTIALS");
  }

  // Checked AFTER the password, on purpose: answering "this account is
  // suspended" to an unauthenticated guess would leak account state to someone
  // who has not proven they own it.
  if (user.status !== "active") {
    throw new AuthorizationError("This account is not active");
  }

  logger.info({ userId: user.id }, "user logged in");
  return { user, tokens: await startSession(user, context) };
}

/**
 * Refresh with rotation and reuse detection — the most subtle function here.
 *
 * WHY ROTATE AT ALL
 *   A long-lived refresh token that never changes is a 30-day password. If it
 *   leaks, the attacker has 30 days of access and we have no way to notice.
 *   Rotation means each refresh token is single-use: using it invalidates it
 *   and issues a replacement.
 *
 * WHY THAT ENABLES THEFT DETECTION
 *   Single use creates a detectable collision. Suppose an attacker steals
 *   token T:
 *     - If the victim refreshes first, T is consumed. The attacker later
 *       presents T, which no longer matches any session.
 *     - If the attacker refreshes first, the victim's next refresh presents the
 *       now-consumed T.
 *   Either way, a consumed token is presented again. We cannot tell which
 *   party is the impostor, so the safe response is to revoke the whole family:
 *   both sides are logged out, the attacker loses access, and the victim gets
 *   a (mildly annoying) re-login. Silence would mean leaving the thief in.
 *
 * THE RACE THIS HAS TO SURVIVE
 *   Two browser tabs whose access tokens expire together both POST /auth/refresh
 *   with the same cookie. Exactly one wins the atomic swap. Treating the loser
 *   as a thief would log real users out constantly — a security mechanism that
 *   fires mostly on false positives gets switched off, so it must not.
 *
 *   Hence the grace window: for REFRESH_REUSE_GRACE seconds, the just-replaced
 *   jti is still honoured and simply rotates again. Beyond that window, a
 *   replay is treated as theft. This is an explicit availability-vs-security
 *   trade: it opens a ~10 second replay window in exchange for not logging
 *   legitimate users out. See docs/CONCURRENCY.md.
 */
export async function refresh(refreshToken, context = {}) {
  if (!refreshToken) {
    throw new AuthenticationError("Refresh token missing", "REFRESH_TOKEN_MISSING");
  }

  // Signature first: a forged or expired token is rejected before any database
  // work, so an attacker cannot use this endpoint to generate load.
  const { userId, jti, familyId } = verifyRefreshToken(refreshToken);

  const now = new Date();
  const next = signRefreshToken({ userId, familyId });

  /**
   * ATOMIC CLAIM. findOneAndUpdate is a single document operation, and MongoDB
   * guarantees that a single-document write is atomic. The filter includes the
   * old jti, so of N concurrent callers presenting the same token, exactly one
   * matches-and-updates; the rest find nothing because the jti has already
   * changed. This is compare-and-swap, expressed as a query.
   *
   * Note that `expiresAt` is NOT extended. The session has an absolute 30-day
   * lifetime from login rather than a sliding one, so a stolen token cannot be
   * kept alive forever by refreshing it.
   */
  const rotated = await Session.findOneAndUpdate(
    { jti, revokedAt: null, expiresAt: { $gt: now } },
    {
      $set: {
        jti: next.jti,
        replacedJti: jti,
        replacedAt: now,
        lastUsedAt: now,
      },
    },
    { returnDocument: "after" }
  );

  if (rotated) {
    const user = await User.findById(userId);
    if (!user || user.status !== "active") {
      await revokeFamily(familyId, "reuse_detected");
      throw new AuthenticationError("Session is no longer valid", "SESSION_REVOKED");
    }
    return {
      user,
      tokens: {
        accessToken: signAccessToken(user),
        refreshToken: next.token,
        expiresIn: config.auth.accessTtlSeconds,
      },
    };
  }

  // The claim failed. Either this is the losing tab of a concurrent refresh
  // (benign) or a replay of a consumed token (hostile). Distinguish by looking
  // for a live session that replaced exactly this jti, recently.
  const graceCutoff = new Date(now.getTime() - config.auth.refreshReuseGraceSeconds * 1000);
  const graceSession = await Session.findOne({
    replacedJti: jti,
    revokedAt: null,
    expiresAt: { $gt: now },
    replacedAt: { $gt: graceCutoff },
  });

  if (graceSession) {
    // Benign. Rotate again from the session's CURRENT jti so this caller also
    // leaves with a valid, unique token.
    const graceNext = signRefreshToken({ userId, familyId: graceSession.familyId });
    const regranted = await Session.findOneAndUpdate(
      { _id: graceSession._id, jti: graceSession.jti, revokedAt: null },
      {
        $set: {
          jti: graceNext.jti,
          replacedJti: graceSession.jti,
          replacedAt: now,
          lastUsedAt: now,
        },
      },
      { returnDocument: "after" }
    );

    if (regranted) {
      const user = await User.findById(userId);
      if (user && user.status === "active") {
        logger.debug({ userId }, "refresh served from reuse grace window");
        return {
          user,
          tokens: {
            accessToken: signAccessToken(user),
            refreshToken: graceNext.token,
            expiresIn: config.auth.accessTtlSeconds,
          },
        };
      }
    }
    // Fell through: a third caller raced us even here. Fail safely rather than
    // retrying in a loop.
    throw new AuthenticationError("Please sign in again", "SESSION_REVOKED");
  }

  /**
   * TOKEN REUSE. The signature was valid — so this token really was issued by
   * us — but it no longer matches any live session and is outside the grace
   * window. Revoke the entire family.
   */
  const revokedCount = await revokeFamily(familyId, "reuse_detected");
  logger.warn(
    { userId, familyId, revokedCount, ip: context.ip },
    "refresh token reuse detected; family revoked"
  );

  throw new AuthenticationError("Please sign in again", "SESSION_REVOKED");
}

/** Revoke every live session in a family. @returns {Promise<number>} */
export async function revokeFamily(familyId, reason) {
  const result = await Session.updateMany(
    { familyId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  );
  return result.modifiedCount;
}

/**
 * Logout.
 *
 * IDEMPOTENT BY DESIGN: logging out an already-revoked or unknown session is a
 * success, not a 404. The caller's intent — "this session must not work" — is
 * satisfied either way, and a retried request after a flaky network must not
 * produce an error. We also swallow an invalid token here for the same reason:
 * refusing to log someone out because their token is malformed is absurd.
 */
export async function logout(refreshToken) {
  if (!refreshToken) return;
  try {
    const { jti } = verifyRefreshToken(refreshToken);
    await Session.updateOne(
      { jti, revokedAt: null },
      { $set: { revokedAt: new Date(), revokedReason: "logout" } }
    );
  } catch {
    // Expired or malformed: nothing to revoke, and the client is clearing its
    // cookie regardless.
  }
}

/** "Sign out everywhere" — also what a password change should trigger. */
export async function logoutAll(userId, reason = "logout") {
  const result = await Session.updateMany(
    { userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } }
  );
  return result.modifiedCount;
}

export async function getCurrentUser(userId) {
  const user = await User.findById(userId);
  if (!user || user.status === "deleted") throw new NotFoundError("User");
  return user;
}
