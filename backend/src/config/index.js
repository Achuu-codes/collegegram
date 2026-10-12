/**
 * Centralized, validated configuration.
 *
 * Why this file exists:
 *   `process.env` is a bag of strings that may or may not be present. Reading it
 *   directly from twenty places means twenty opportunities for a typo'd key to
 *   silently become `undefined` and surface as a confusing runtime error much
 *   later (e.g. jwt.sign throwing "secretOrPrivateKey must have a value" on the
 *   first login attempt, in production, at 2am).
 *
 *   Instead we parse and validate the entire environment exactly once, at boot,
 *   and crash immediately with a readable message if anything is missing or
 *   malformed. This is the "fail fast" principle: a process that cannot possibly
 *   work correctly should refuse to start rather than accept traffic and fail
 *   unpredictably per-request.
 *
 * Everything downstream imports the frozen `config` object, never process.env.
 */
import "dotenv/config";
import { z } from "zod";

/** Coerce "1h", "15m", "30d", "90" (seconds) into seconds. */
const durationToSeconds = (value) => {
  const match = /^(\d+)\s*([smhd]?)$/.exec(String(value).trim());
  if (!match) return Number.NaN;
  const amount = Number(match[1]);
  const unit = match[2] || "s";
  return amount * { s: 1, m: 60, h: 3600, d: 86400 }[unit];
};

const duration = (fallback) =>
  z
    .string()
    .default(fallback)
    .transform(durationToSeconds)
    .pipe(z.number().int().positive());

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(5050),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),

  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),
  MONGODB_URI_TEST: z.string().optional(),

  REDIS_URL: z.string().min(1).default("redis://127.0.0.1:6379"),

  // Two separate secrets so that a leaked access-token secret cannot be used to
  // mint refresh tokens, and so the two can be rotated independently.
  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be >= 32 chars"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be >= 32 chars"),
  ACCESS_TOKEN_TTL: duration("15m"),
  REFRESH_TOKEN_TTL: duration("30d"),
  // Window during which a just-rotated refresh token is still accepted, so that
  // two tabs refreshing simultaneously do not look like a token replay. Trades
  // a small replay window for not logging legitimate users out. See
  // session.model.js and docs/CONCURRENCY.md.
  REFRESH_REUSE_GRACE: duration("10s"),

  // bcrypt work factor. Each +1 doubles hashing time. 12 is a deliberate
  // balance: slow enough to make offline brute force expensive, fast enough
  // (~250ms on this machine) that login latency stays acceptable.
  BCRYPT_COST: z.coerce.number().int().min(10).max(15).default(12),

  // Comma-separated allowlist. Never "*" once credentials are involved.
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:5173")
    .transform((s) => s.split(",").map((o) => o.trim()).filter(Boolean)),

  JSON_BODY_LIMIT: z.string().default("64kb"),

  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  // Deliberately console.error and not the logger: the logger itself depends on
  // config, so at this point it does not exist yet.
  console.error(`Invalid environment configuration:\n${issues}\n`);
  console.error("Copy .env.example to .env and fill in the missing values.");
  process.exit(1);
}

const env = parsed.data;
const isTest = env.NODE_ENV === "test";

export const config = Object.freeze({
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === "production",
  isTest,
  port: env.PORT,
  logLevel: isTest ? "silent" : env.LOG_LEVEL,

  mongo: Object.freeze({
    // Tests must never touch the development database: they drop collections.
    uri: isTest ? (env.MONGODB_URI_TEST ?? `${env.MONGODB_URI}_test`) : env.MONGODB_URI,
  }),

  redis: Object.freeze({ url: env.REDIS_URL }),

  auth: Object.freeze({
    accessSecret: env.JWT_ACCESS_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    accessTtlSeconds: env.ACCESS_TOKEN_TTL,
    refreshTtlSeconds: env.REFRESH_TOKEN_TTL,
    refreshReuseGraceSeconds: env.REFRESH_REUSE_GRACE,
    bcryptCost: isTest ? 10 : env.BCRYPT_COST, // keep the test suite fast
    issuer: "collegegram",
  }),

  http: Object.freeze({
    corsOrigins: env.CORS_ORIGINS,
    jsonBodyLimit: env.JSON_BODY_LIMIT,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
  }),
});

export default config;
