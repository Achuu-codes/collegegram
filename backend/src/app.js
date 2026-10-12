/**
 * Express application assembly.
 *
 * Note that this module builds the app but never calls `listen()`. Binding a
 * port is the job of server.js. Keeping them separate is what lets the test
 * suite import the fully-wired app and drive it in-process with supertest —
 * no port, no race on startup, no cleanup of stray listeners.
 *
 * MIDDLEWARE ORDER IS SEMANTIC, NOT COSMETIC. Express runs these in the order
 * they are registered, and several of these would be useless or wrong if moved:
 *
 *   1. requestContext  must be first, so that everything after it — including
 *                      the error handler — has `req.id` and `req.log`.
 *   2. helmet          sets security headers; must run before anything can
 *                      short-circuit and send a response without them.
 *   3. cors            must precede the routes, because a rejected preflight
 *                      should never reach application code.
 *   4. body parsers    must precede sanitize/validate, which inspect req.body.
 *   5. sanitize        must precede the routes (defence in depth on raw input).
 *   6. routes
 *   7. notFoundHandler catches anything no route matched.
 *   8. errorHandler    LAST, always. Express selects error middleware by its
 *                      four-parameter arity, and only considers handlers
 *                      registered after the one that threw.
 */
import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";

import config from "./config/index.js";
import requestContext from "./middleware/requestContext.js";
import sanitize from "./middleware/sanitize.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";
import healthRoutes from "./modules/health/health.routes.js";
import authRoutes from "./modules/auth/auth.routes.js";
import postRoutes from "./modules/post/post.routes.js";

export function createApp() {
  const app = express();

  // Behind a reverse proxy (nginx, Render, Fly), the socket's remote address is
  // the proxy's. Trusting the first X-Forwarded-For hop makes req.ip the real
  // client, which the rate limiter depends on for correct per-client keys.
  // 'trust proxy' is deliberately NOT enabled in development, where there is no
  // proxy and trusting the header would let any client spoof its own IP and
  // bypass rate limits.
  if (config.isProduction) app.set("trust proxy", 1);

  app.disable("x-powered-by"); // do not advertise the framework

  app.use(requestContext);

  app.use(
    helmet({
      // This is a JSON API; it serves no HTML, so the browser-facing policies
      // that matter are the ones preventing content sniffing and framing.
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: "same-site" },
    })
  );

  app.use(
    cors({
      // An explicit allowlist from config. Note that `origin: true` (reflect
      // any origin) combined with `credentials: true` is a serious hole: it
      // would let *any* website make authenticated requests with the user's
      // cookies. Browsers forbid `*` with credentials for this reason, and
      // reflection is the same mistake wearing a disguise.
      origin: config.http.corsOrigins,
      // Required for the refresh-token cookie to be sent cross-origin.
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Request-Id", "Idempotency-Key"],
      exposedHeaders: ["X-Request-Id", "Retry-After"],
      maxAge: 600, // cache preflights for 10 minutes
    })
  );

  // An explicit body limit. The default is 100kb; we set it consciously because
  // an unbounded parser lets one request allocate arbitrary memory.
  app.use(express.json({ limit: config.http.jsonBodyLimit }));
  app.use(cookieParser());
  app.use(sanitize);

  app.use("/health", healthRoutes);
  app.use("/auth", authRoutes);
  app.use("/posts", postRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export default createApp;
