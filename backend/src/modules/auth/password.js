/**
 * Password hashing.
 *
 * WHY HASHING, AND WHY NOT A PLAIN HASH
 *   The threat model is a database breach. Plaintext passwords would be
 *   catastrophic, but so would SHA-256: a modern GPU computes billions of
 *   SHA-256 hashes per second, so an attacker with the dump recovers most real
 *   passwords in hours. A password hash must be *deliberately slow*.
 *
 * WHY bcrypt
 *   bcrypt has a tunable cost factor (work doubles per +1) and, crucially, is
 *   memory-hard enough to be awkward to accelerate on GPUs. Argon2id is the
 *   stronger modern choice, but bcrypt at cost 12 is well above the bar for
 *   this application and avoids a heavier native dependency.
 *
 * WHY NO SEPARATE SALT COLUMN
 *   A common misconception is that you must store a salt yourself. bcrypt
 *   generates a random 16-byte salt per password and embeds it in the output
 *   string, together with the algorithm version and cost:
 *
 *       $2b$12$N9qo8uLOickgx2ZMRZoMye....
 *        │  │  └ 22-char base64 salt + 31-char hash
 *        │  └ cost factor (2^12 = 4096 iterations)
 *        └ algorithm variant
 *
 *   The salt is what makes two users with the same password hash differently,
 *   which defeats rainbow tables and makes an attacker brute-force each account
 *   separately instead of all of them at once. Because the cost is embedded,
 *   raising BCRYPT_COST later does not invalidate old hashes: they keep
 *   verifying at their original cost, and can be upgraded on next login.
 *
 * THE 72-BYTE TRAP
 *   bcrypt silently ignores everything past 72 BYTES of input. A user with a
 *   100-character passphrase would have the tail discarded with no error, and —
 *   worse — two different long passwords sharing a 72-byte prefix would both
 *   verify. Note bytes, not characters: emoji and accented characters consume
 *   several bytes each. We reject over-long passwords at validation time rather
 *   than silently truncating, so the behaviour is explicit instead of a
 *   lurking surprise.
 */
import bcrypt from "bcrypt";
import config from "../../config/index.js";

export const MAX_PASSWORD_BYTES = 72;

export const hashPassword = (plain) => bcrypt.hash(plain, config.auth.bcryptCost);

export const verifyPassword = (plain, hash) => bcrypt.compare(plain, hash);

/**
 * A pre-computed hash of a value nobody can supply, used to burn the same CPU
 * time as a real verification when the account does not exist.
 *
 * WHY THIS MATTERS — user enumeration via timing:
 *   The naive login is `if (!user) return 401` before hashing. That path
 *   returns in ~1ms while a real account takes ~250ms (the bcrypt work). An
 *   attacker measures the difference and learns which email addresses are
 *   registered, without ever guessing a password — useful for targeted
 *   phishing and for credential-stuffing lists. Comparing against this dummy
 *   hash makes both paths cost the same.
 *
 *   This is a deliberate, bounded mitigation: it equalizes the dominant cost,
 *   not every nanosecond. Defeating a determined statistical attack also needs
 *   rate limiting, which we have on the login route.
 */
let dummyHashPromise = null;
export function getDummyHash() {
  dummyHashPromise ??= bcrypt.hash("timing-attack-mitigation-placeholder", config.auth.bcryptCost);
  return dummyHashPromise;
}
