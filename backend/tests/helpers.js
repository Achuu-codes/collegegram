/**
 * Shared test utilities.
 *
 * `request(app)` from supertest drives the Express app IN-PROCESS: it binds an
 * ephemeral port, issues a real HTTP request, and tears down. That means the
 * full middleware stack runs — CORS, helmet, sanitize, validation, the error
 * handler — so these are genuine integration tests of the HTTP surface, not
 * controller functions called with fake req/res objects. Bugs in middleware
 * ORDER are invisible to the latter and caught by the former.
 */
import supertest from "supertest";
import { createApp } from "../src/app.js";
import * as authService from "../src/modules/auth/auth.service.js";
import { REFRESH_COOKIE_NAME } from "../src/modules/auth/token.service.js";

export const app = createApp();
export const api = () => supertest(app);

let counter = 0;

/** Unique, valid registration payload. */
export function userPayload(overrides = {}) {
  counter += 1;
  return {
    email: `student${counter}@university.edu`,
    username: `student${counter}`,
    displayName: `Student ${counter}`,
    password: "correct-horse-battery-staple",
    ...overrides,
  };
}

/** Pull the refresh cookie value out of a response's Set-Cookie header. */
export function refreshCookieFrom(response) {
  const raw = response.headers["set-cookie"] ?? [];
  const cookie = raw.find((c) => c.startsWith(`${REFRESH_COOKIE_NAME}=`));
  if (!cookie) return null;
  return cookie.split(";")[0].split("=").slice(1).join("=");
}

/** Register a user and return everything a test might need from it. */
export async function registerUser(overrides = {}) {
  const payload = userPayload(overrides);
  const response = await api().post("/auth/register").send(payload);
  return {
    payload,
    response,
    user: response.body?.data?.user,
    accessToken: response.body?.data?.accessToken,
    refreshToken: refreshCookieFrom(response),
  };
}

export const authHeader = (token) => ["Authorization", `Bearer ${token}`];

/**
 * Create a user by calling the service directly, bypassing HTTP.
 *
 * Why this exists alongside `registerUser`: POST /auth/register is rate
 * limited to 3 per hour per IP, which is correct in production and hostile to
 * a test that needs five users to vote on one post. Driving registration
 * through HTTP in such a test couples it to the limiter's configuration, so it
 * would fail the day someone legitimately tightens the limit — a false alarm
 * about voting caused by a change to signup.
 *
 * Tests that are ABOUT the HTTP surface (validation, status codes, cookies,
 * the limiter itself) still use `registerUser` and go through the stack.
 */
export async function makeUser(overrides = {}) {
  const payload = userPayload(overrides);
  const { user, tokens } = await authService.register(payload, { ip: "127.0.0.1" });
  return {
    payload,
    user: user.toJSON(),
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
  };
}
