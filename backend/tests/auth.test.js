/**
 * Auth integration tests.
 *
 * These are deliberately organized around BEHAVIOUR AND THREATS rather than
 * around functions. Each describe block names a property the system must have;
 * if one of these fails, something a user or an attacker can observe has
 * changed. Tests written per-function ("register() calls User.create") pass
 * while the system is broken and break while the system is fine.
 */
import { describe, it, expect } from "vitest";
import { api, registerUser, userPayload, refreshCookieFrom, authHeader } from "./helpers.js";
import { Session } from "../src/modules/auth/session.model.js";
import { User } from "../src/modules/user/user.model.js";
import { REFRESH_COOKIE_NAME } from "../src/modules/auth/token.service.js";

describe("POST /auth/register", () => {
  it("creates an account and returns an access token plus a refresh cookie", async () => {
    const { response, user, accessToken, refreshToken } = await registerUser();

    expect(response.status).toBe(201);
    expect(user.username).toBe(response.body.data.user.username);
    expect(accessToken).toBeTruthy();
    expect(refreshToken).toBeTruthy();
    expect(user.role).toBe("user");
  });

  it("never exposes the password hash", async () => {
    const { response } = await registerUser();
    // Check the whole serialized body, not just the user object: a hash leaking
    // through any nested field is equally fatal.
    expect(JSON.stringify(response.body)).not.toMatch(/\$2[aby]\$/);
    expect(response.body.data.user.passwordHash).toBeUndefined();
  });

  it("marks the refresh cookie httpOnly and path-scoped to /auth", async () => {
    const { response } = await registerUser();
    const cookie = response.headers["set-cookie"].find((c) =>
      c.startsWith(REFRESH_COOKIE_NAME)
    );
    // httpOnly is what keeps an XSS payload from reading the 30-day credential.
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/auth/i);
  });

  it("derives collegeDomain from the email domain", async () => {
    const { user } = await registerUser({ email: "someone@mit.edu" });
    const stored = await User.findById(user.id);
    expect(stored.collegeDomain).toBe("mit.edu");
  });

  it("rejects a duplicate email with 409 EMAIL_TAKEN", async () => {
    const first = await registerUser();
    const response = await api()
      .post("/auth/register")
      .send(userPayload({ email: first.payload.email }));

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("EMAIL_TAKEN");
  });

  it("rejects a duplicate username with 409 USERNAME_TAKEN", async () => {
    const first = await registerUser();
    const response = await api()
      .post("/auth/register")
      .send(userPayload({ username: first.payload.username }));

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("USERNAME_TAKEN");
  });

  /**
   * THE RACE THE UNIQUE INDEX EXISTS TO WIN.
   *
   * Both requests are in flight before either completes, so a service-layer
   * "does this email exist?" check would pass in BOTH — the classic
   * time-of-check/time-of-use hole. Only the database can arbitrate, and this
   * test is the proof that it does.
   */
  it("allows exactly one of two concurrent registrations for the same email", async () => {
    const payload = userPayload();

    const [a, b] = await Promise.all([
      api().post("/auth/register").send(payload),
      api().post("/auth/register").send({ ...payload, username: `${payload.username}x` }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect(await User.countDocuments({ email: payload.email })).toBe(1);
  });

  it("rejects a password under 10 characters with a field-level error", async () => {
    const response = await api().post("/auth/register").send(userPayload({ password: "short1" }));

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("VALIDATION_FAILED");
    expect(response.body.error.details).toContainEqual(
      expect.objectContaining({ field: "password" })
    );
  });

  it("rejects a password longer than bcrypt's 72-byte limit instead of truncating", async () => {
    const response = await api()
      .post("/auth/register")
      .send(userPayload({ password: "a".repeat(100) }));

    expect(response.status).toBe(400);
    expect(response.body.error.details[0].field).toBe("password");
  });

  it("counts BYTES, not characters, against the bcrypt limit", async () => {
    // 30 emoji = 120 bytes: well under 72 characters, well over 72 bytes.
    const response = await api()
      .post("/auth/register")
      .send(userPayload({ password: "🔐".repeat(30) }));

    expect(response.status).toBe(400);
  });

  /**
   * MASS ASSIGNMENT. The body claims an elevated role. Because the Zod schema
   * does not declare `role`, the key is stripped before the service ever sees
   * it, and the model's default applies.
   */
  it("ignores a client-supplied role (no privilege escalation at signup)", async () => {
    const response = await api()
      .post("/auth/register")
      .send({ ...userPayload(), role: "admin", reputation: 99999 });

    expect(response.status).toBe(201);
    expect(response.body.data.user.role).toBe("user");
    expect(response.body.data.user.reputation).toBe(0);
  });

  it("rejects a malformed email", async () => {
    const response = await api().post("/auth/register").send(userPayload({ email: "not-an-email" }));
    expect(response.status).toBe(400);
  });

  it("rejects a username with illegal characters", async () => {
    const response = await api().post("/auth/register").send(userPayload({ username: "bad user!" }));
    expect(response.status).toBe(400);
  });
});

describe("POST /auth/login", () => {
  it("accepts the correct password and issues tokens", async () => {
    const { payload } = await registerUser();

    const response = await api()
      .post("/auth/login")
      .send({ identifier: payload.email, password: payload.password });

    expect(response.status).toBe(200);
    expect(response.body.data.accessToken).toBeTruthy();
    expect(refreshCookieFrom(response)).toBeTruthy();
  });

  it("accepts a username in place of an email", async () => {
    const { payload } = await registerUser();

    const response = await api()
      .post("/auth/login")
      .send({ identifier: payload.username, password: payload.password });

    expect(response.status).toBe(200);
  });

  it("is case-insensitive on the identifier", async () => {
    const { payload } = await registerUser();

    const response = await api()
      .post("/auth/login")
      .send({ identifier: payload.email.toUpperCase(), password: payload.password });

    expect(response.status).toBe(200);
  });

  it("rejects a wrong password with 401", async () => {
    const { payload } = await registerUser();

    const response = await api()
      .post("/auth/login")
      .send({ identifier: payload.email, password: "definitely-not-the-password" });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  /**
   * USER ENUMERATION. An unknown account and a wrong password must be
   * indistinguishable to the caller. If they differed, an attacker could
   * harvest valid email addresses without ever guessing a password.
   */
  it("returns an identical error for an unknown account and a wrong password", async () => {
    const { payload } = await registerUser();

    const wrongPassword = await api()
      .post("/auth/login")
      .send({ identifier: payload.email, password: "wrong-password-here" });

    const unknownUser = await api()
      .post("/auth/login")
      .send({ identifier: "nobody@nowhere.edu", password: "wrong-password-here" });

    expect(unknownUser.status).toBe(wrongPassword.status);
    expect(unknownUser.body.error.code).toBe(wrongPassword.body.error.code);
    expect(unknownUser.body.error.message).toBe(wrongPassword.body.error.message);
  });

  /**
   * NoSQL OPERATOR INJECTION. Against a naive `findOne({ email, password })`
   * this payload matches the first user in the collection and logs the
   * attacker in as them. Zod's `z.string()` rejects the object structurally,
   * and the sanitize middleware rejects the `$` key as a second layer.
   */
  it("rejects a Mongo operator object in the identifier", async () => {
    await registerUser();

    const response = await api()
      .post("/auth/login")
      .send({ identifier: { $ne: null }, password: { $ne: null } });

    expect(response.status).toBe(400);
    expect(response.status).not.toBe(200);
  });

  it("rejects a suspended account after validating the password", async () => {
    const { payload, user } = await registerUser();
    await User.findByIdAndUpdate(user.id, { status: "suspended" });

    const response = await api()
      .post("/auth/login")
      .send({ identifier: payload.email, password: payload.password });

    // 403, not 401: we know who they are; they are simply not allowed in.
    expect(response.status).toBe(403);
  });
});

describe("GET /auth/me", () => {
  it("returns the current user for a valid access token", async () => {
    const { accessToken, user } = await registerUser();

    const response = await api().get("/auth/me").set(...authHeader(accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.user.id).toBe(user.id);
  });

  it("rejects a request with no token", async () => {
    const response = await api().get("/auth/me");
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("TOKEN_MISSING");
  });

  it("rejects a malformed token", async () => {
    const response = await api().get("/auth/me").set(...authHeader("not.a.jwt"));
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("TOKEN_INVALID");
  });

  /**
   * THE `alg: "none"` ATTACK. A token whose header claims no algorithm, with
   * the signature stripped. Libraries that trusted the token's own header
   * accepted these. We pin algorithms: ["HS256"] on every verify.
   */
  it("rejects an unsigned token claiming alg:none", async () => {
    const { user } = await registerUser();
    const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
    const forged = `${b64({ alg: "none", typ: "JWT" })}.${b64({
      sub: user.id,
      type: "access",
      role: "admin",
    })}.`;

    const response = await api().get("/auth/me").set(...authHeader(forged));

    expect(response.status).toBe(401);
  });

  it("rejects a refresh token used as an access token", async () => {
    const { refreshToken } = await registerUser();

    const response = await api().get("/auth/me").set(...authHeader(refreshToken));

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("TOKEN_INVALID");
  });
});

describe("POST /auth/refresh — rotation and reuse detection", () => {
  it("issues a new token pair and invalidates the old refresh token", async () => {
    const { refreshToken } = await registerUser();

    const response = await api()
      .post("/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE_NAME}=${refreshToken}`);

    expect(response.status).toBe(200);
    const rotated = refreshCookieFrom(response);
    expect(rotated).toBeTruthy();
    expect(rotated).not.toBe(refreshToken); // genuinely rotated, not reissued
    expect(response.body.data.accessToken).toBeTruthy();
  });

  it("keeps the session in the same family across rotation", async () => {
    const { refreshToken, user } = await registerUser();
    const before = await Session.findOne({ userId: user.id });

    await api().post("/auth/refresh").set("Cookie", `${REFRESH_COOKIE_NAME}=${refreshToken}`);

    const after = await Session.findOne({ userId: user.id });
    expect(after.familyId).toBe(before.familyId); // same login
    expect(after.jti).not.toBe(before.jti); // new token id
    // One row per login, mutated in place: rotation must not accumulate rows.
    expect(await Session.countDocuments({ userId: user.id })).toBe(1);
  });

  it("rejects a request with no refresh cookie", async () => {
    const response = await api().post("/auth/refresh");
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("REFRESH_TOKEN_MISSING");
  });

  /**
   * CONCURRENT REFRESH — the benign race. Two tabs refresh at the same instant
   * with the same cookie. Exactly one wins the atomic swap; the loser must be
   * served from the grace window rather than being mistaken for a thief.
   * Without the grace window this test fails and real users get logged out.
   */
  it("serves both of two simultaneous refreshes with the same token", async () => {
    const { refreshToken } = await registerUser();

    const [a, b] = await Promise.all([
      api().post("/auth/refresh").set("Cookie", `${REFRESH_COOKIE_NAME}=${refreshToken}`),
      api().post("/auth/refresh").set("Cookie", `${REFRESH_COOKIE_NAME}=${refreshToken}`),
    ]);

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Each caller leaves with its own distinct token.
    expect(refreshCookieFrom(a)).not.toBe(refreshCookieFrom(b));
  });

  /**
   * TOKEN THEFT. A consumed refresh token is presented again after the grace
   * window has passed. We cannot tell the thief from the victim, so the whole
   * family is revoked and both must sign in again.
   *
   * The grace window is expired by ageing `replacedAt` directly rather than by
   * sleeping: a test that sleeps for the real duration is slow, and a test
   * tuned to a timing window is flaky.
   */
  it("revokes the entire session family when a consumed token is replayed", async () => {
    const { refreshToken, user } = await registerUser();

    const first = await api()
      .post("/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE_NAME}=${refreshToken}`);
    expect(first.status).toBe(200);
    const liveToken = refreshCookieFrom(first);

    await Session.updateMany({ userId: user.id }, { $set: { replacedAt: new Date(0) } });

    // The attacker replays the ORIGINAL, already-consumed token.
    const replay = await api()
      .post("/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE_NAME}=${refreshToken}`);

    expect(replay.status).toBe(401);
    expect(replay.body.error.code).toBe("SESSION_REVOKED");

    const session = await Session.findOne({ userId: user.id });
    expect(session.revokedAt).not.toBeNull();
    expect(session.revokedReason).toBe("reuse_detected");

    // And the victim's current, legitimate token is dead too — that is the
    // intended, deliberately blunt consequence of not knowing who is who.
    const victim = await api()
      .post("/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE_NAME}=${liveToken}`);
    expect(victim.status).toBe(401);
  });

  it("rejects a refresh token after the account is suspended", async () => {
    const { refreshToken, user } = await registerUser();
    await User.findByIdAndUpdate(user.id, { status: "suspended" });

    const response = await api()
      .post("/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE_NAME}=${refreshToken}`);

    expect(response.status).toBe(401);
  });
});

describe("POST /auth/logout", () => {
  it("revokes the session so the refresh token stops working", async () => {
    const { refreshToken } = await registerUser();

    const logout = await api()
      .post("/auth/logout")
      .set("Cookie", `${REFRESH_COOKIE_NAME}=${refreshToken}`);
    expect(logout.status).toBe(204);

    const afterLogout = await api()
      .post("/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE_NAME}=${refreshToken}`);
    expect(afterLogout.status).toBe(401);
  });

  it("is idempotent — logging out twice still succeeds", async () => {
    const { refreshToken } = await registerUser();
    const cookie = `${REFRESH_COOKIE_NAME}=${refreshToken}`;

    expect((await api().post("/auth/logout").set("Cookie", cookie)).status).toBe(204);
    expect((await api().post("/auth/logout").set("Cookie", cookie)).status).toBe(204);
  });

  it("succeeds with no cookie at all", async () => {
    expect((await api().post("/auth/logout")).status).toBe(204);
  });

  it("logout-all revokes every session for the user", async () => {
    const { payload, accessToken } = await registerUser();
    // A second login = a second device = a second session family.
    await api().post("/auth/login").send({ identifier: payload.email, password: payload.password });

    const response = await api().post("/auth/logout-all").set(...authHeader(accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.sessionsRevoked).toBe(2);
    expect(await Session.countDocuments({ revokedAt: null })).toBe(0);
  });
});

describe("Rate limiting", () => {
  /**
   * Note what this proves and what it does not: the limiter counts and blocks.
   * It does NOT prove the limit is correctly tuned — that is a judgement call
   * documented in auth.routes.js, not a testable property.
   */
  it("blocks the sixth login attempt in the window with 429", async () => {
    const { payload } = await registerUser();
    const attempt = () =>
      api().post("/auth/login").send({ identifier: payload.email, password: "wrong-password" });

    for (let i = 0; i < 5; i += 1) {
      expect((await attempt()).status).toBe(401);
    }

    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    // Retry-After tells a well-behaved client when to come back.
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("blocks login by account even when the password becomes correct", async () => {
    const { payload } = await registerUser();

    for (let i = 0; i < 5; i += 1) {
      await api().post("/auth/login").send({ identifier: payload.email, password: "wrong" });
    }

    // The attacker finally guesses right — and is still locked out, because
    // the limiter runs before authentication.
    const response = await api()
      .post("/auth/login")
      .send({ identifier: payload.email, password: payload.password });

    expect(response.status).toBe(429);
  });
});
