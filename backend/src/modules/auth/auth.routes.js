/**
 * Auth routes.
 *
 * Each route reads as a pipeline of explicit, independently testable concerns:
 *
 *     rateLimit → validate → authenticate? → controller
 *
 * The order is deliberate. Rate limiting runs FIRST so that a flood of garbage
 * requests is rejected before we spend CPU parsing and validating it — a
 * limiter placed after validation still does the expensive work for every
 * attacking request. Validation runs before the controller so the controller
 * can trust its input unconditionally.
 *
 * ON "RPC-LIKE" ROUTES: /auth/login and /auth/refresh are verbs, not resources,
 * which is technically un-RESTful. This is a conscious exception. Modelling a
 * login as `POST /sessions` is more orthodox but obscures intent, and every
 * major API does it this way. REST is a tool for making resource CRUD
 * predictable, not a rule to follow off a cliff; the rest of the API (posts,
 * comments, votes) is properly resource-shaped.
 *
 * RATE LIMIT NUMBERS AND WHY EACH ONE IS SET WHERE IT IS:
 *
 *   login     5 per 15 min, metered per-IP AND per-account.
 *             Two keys, because they stop different attacks. Per-IP stops one
 *             host trying many accounts (credential stuffing). Per-account
 *             stops a distributed botnet trying one account from thousands of
 *             IPs, which a per-IP limit literally cannot observe. 5 attempts
 *             per quarter hour is generous for a human who forgot their
 *             password and ruinous for a brute-force attempt.
 *
 *   register  3 per hour per IP. Signup is expensive (bcrypt) and rarely
 *             repeated legitimately; this is the main defence against
 *             automated account farming.
 *
 *   refresh   30 per 15 min per IP. Must comfortably exceed normal use — one
 *             refresh per 15 minutes per tab — while capping abuse. Set
 *             loosely on purpose: throttling refresh too tightly logs real
 *             users out, which is a worse outcome than the attack it prevents.
 */
import { Router } from "express";
import validate from "../../middleware/validate.js";
import rateLimit from "../../middleware/rateLimit.js";
import { authenticate } from "../../middleware/authenticate.js";
import { registerSchema, loginSchema } from "./auth.schemas.js";
import * as controller from "./auth.controller.js";

const router = Router();

router.post(
  "/register",
  rateLimit({ scope: "register", limit: 3, windowSeconds: 60 * 60 }),
  validate(registerSchema),
  controller.register
);

router.post(
  "/login",
  rateLimit({
    scope: "login",
    limit: 5,
    windowSeconds: 15 * 60,
    keys: (req) => [
      `ip:${req.ip}`,
      // Lowercased so "Alice@x.edu" and "alice@x.edu" share a bucket and the
      // limit cannot be sidestepped by varying capitalization. Optional
      // chaining because this runs BEFORE validation, so the body may be junk.
      req.body?.identifier
        ? `acct:${String(req.body.identifier).toLowerCase().slice(0, 254)}`
        : null,
    ],
  }),
  validate(loginSchema),
  controller.login
);

router.post(
  "/refresh",
  rateLimit({ scope: "refresh", limit: 30, windowSeconds: 15 * 60 }),
  controller.refresh
);

router.post("/logout", controller.logout);

router.post("/logout-all", authenticate, controller.logoutAll);

router.get("/me", authenticate, controller.me);

export default router;
