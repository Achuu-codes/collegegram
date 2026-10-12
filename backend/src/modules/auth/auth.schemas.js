/**
 * Request schemas for the auth routes.
 *
 * PASSWORD POLICY — why there is no "must contain an uppercase letter and a
 * symbol" rule:
 *   Composition rules were formally deprecated by NIST SP 800-63B. They push
 *   users toward predictable mutations ("Password1!") that barely slow a
 *   cracking dictionary, while genuinely strong passphrases get rejected for
 *   lacking a digit. The guidance is: require meaningful LENGTH, screen against
 *   known-breached and obvious passwords, and otherwise leave users alone. That
 *   is exactly what the schema below does, and it is a deliberate decision
 *   rather than laziness.
 *
 *   The upper bound is not cosmetic either: bcrypt silently discards input past
 *   72 bytes (see password.js), so we reject rather than truncate. The check is
 *   in BYTES because multi-byte characters — accents, emoji — consume 2-4 bytes
 *   each, so a 30-character emoji password can exceed the limit.
 */
import { z } from "zod";
import { MAX_PASSWORD_BYTES } from "./password.js";

/** A short, illustrative blocklist. Production would screen against a breach
 *  corpus such as Have I Been Pwned's k-anonymity range API. */
const OBVIOUS_PASSWORDS = new Set([
  "password", "password1", "password123", "12345678", "123456789", "1234567890",
  "qwertyuiop", "letmein123", "iloveyou1", "collegegram", "changeme123",
]);

const password = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_PASSWORD_BYTES,
    `Password must be at most ${MAX_PASSWORD_BYTES} bytes (note: emoji and accented characters count as several bytes each)`
  )
  .refine(
    (value) => !OBVIOUS_PASSWORDS.has(value.toLowerCase()),
    "That password is too common; please choose another"
  );

const email = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .email("Must be a valid email address");

const username = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Username must be at least 3 characters")
  .max(30, "Username must be at most 30 characters")
  .regex(
    /^[a-z0-9_]+$/,
    "Username may contain only lowercase letters, numbers and underscores"
  );

export const registerSchema = {
  body: z
    .object({
      email,
      username,
      displayName: z.string().trim().min(1, "Display name is required").max(60),
      password,
    })
    // .strict() would reject unknown keys loudly; the default strips them
    // silently, which is what we want: a client sending {"role":"admin"} gets a
    // normal account rather than an error that tells them the field exists.
    .refine(
      (data) => !data.password.toLowerCase().includes(data.username),
      { message: "Password must not contain your username", path: ["password"] }
    ),
};

export const loginSchema = {
  body: z.object({
    // One field accepting either an email or a username. The service resolves
    // it with a single $or query against two unique indexes.
    identifier: z.string().trim().min(1, "Email or username is required").max(254),
    // No format rules on login: the stored password was validated at
    // registration, and tightening rules later must never lock existing users
    // out of their own accounts.
    password: z.string().min(1, "Password is required").max(512),
  }),
};
