/**
 * Refresh-token sessions.
 *
 * WHY THIS IS IN MONGODB AND NOT REDIS
 *
 *   The reflexive answer is "sessions go in Redis." I deliberately did not do
 *   that, and this is the reasoning an interviewer should hear:
 *
 *   - Redis in this project is a cache, and a cache may be flushed, evicted
 *     under memory pressure, or restarted at any time without data loss being
 *     an incident. If sessions lived there, a `redis-server` restart would log
 *     out every user on the platform. That is a correctness/UX regression
 *     caused by an optimization layer, which is exactly the coupling the rest
 *     of this codebase avoids (see lib/redis.js).
 *
 *   - The access pattern does not need Redis. A refresh happens roughly once
 *     per access-token lifetime per active session — with a 15-minute access
 *     token, that is ~4 reads/hour/user, not per request. One indexed MongoDB
 *     lookup at that rate is nothing. Redis earns its place on hot paths; this
 *     is not one.
 *
 *   - Rotation requires an atomic compare-and-swap. `findOneAndUpdate` gives us
 *     that in a single document operation, with durability. Doing the same in
 *     Redis needs a Lua script and still is not durable.
 *
 *   The cost of this choice: a database round trip on refresh, and session rows
 *   that must be cleaned up (handled by the TTL index below).
 *
 * WHAT A "FAMILY" IS
 *
 *   One login creates one family (`familyId`), which survives every rotation.
 *   The `jti` changes on each refresh; the family does not. The family is what
 *   lets us punish token theft: if a token that was already rotated away is
 *   presented again, we cannot tell whether the replayer is the thief or the
 *   victim — so we revoke the entire family and force a fresh login. See
 *   token reuse detection in auth.service.js.
 */
import mongoose from "mongoose";

const sessionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    /** Constant for the life of one login, across all rotations. */
    familyId: { type: String, required: true },

    /**
     * The jti of the CURRENTLY VALID refresh token for this session.
     * Rotating = atomically swapping this value. Unique, so two sessions can
     * never claim the same token id.
     */
    jti: { type: String, required: true },

    /**
     * The jti this one replaced, kept briefly to absorb the concurrent-refresh
     * race (two browser tabs refreshing at the same instant). Without it, the
     * losing tab looks exactly like a token replay and we would log the user
     * out of a legitimate session. See REFRESH_REUSE_GRACE_SECONDS.
     */
    replacedJti: { type: String, default: null },
    replacedAt: { type: Date, default: null },

    expiresAt: { type: Date, required: true },
    lastUsedAt: { type: Date, default: Date.now },

    revokedAt: { type: Date, default: null },
    revokedReason: {
      type: String,
      enum: ["logout", "rotated", "reuse_detected", "password_changed", null],
      default: null,
    },

    /**
     * Context for a future "your active sessions" screen and for incident
     * review. The IP is stored as-is for development; in production this is
     * personal data under GDPR and should be truncated or hashed, which is
     * noted in docs/SECURITY.md rather than silently ignored.
     */
    userAgent: { type: String, maxlength: 400 },
    ip: { type: String, maxlength: 64 },
  },
  { timestamps: true }
);

/**
 * INDEXES
 *
 * 1. { jti: 1 } unique — the refresh lookup, and the uniqueness guarantee that
 *    makes atomic rotation safe.
 */
sessionSchema.index({ jti: 1 }, { unique: true });

/** 2. Reuse detection: find the live sessions of a family to revoke them. */
sessionSchema.index({ familyId: 1 });

/** 3. The grace-window lookup for a concurrent refresh. Sparse: the vast
 *     majority of rows have replacedJti: null and need not be indexed. */
sessionSchema.index({ replacedJti: 1 }, { sparse: true });

/** 4. "Log this user out everywhere" / list a user's sessions. */
sessionSchema.index({ userId: 1, revokedAt: 1 });

/**
 * 5. TTL index: MongoDB deletes documents once `expiresAt` is in the past,
 *    so expired sessions do not accumulate forever.
 *
 *    IMPORTANT CAVEAT, and a favourite interview follow-up: the TTL monitor
 *    runs ONCE PER MINUTE and deletion is best-effort, so a document can
 *    outlive its expiry by a minute or more (longer under load). TTL is garbage
 *    collection, NOT an access-control mechanism. Every query that validates a
 *    session therefore also checks `expiresAt > now` explicitly rather than
 *    trusting the row's absence.
 */
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Session = mongoose.model("Session", sessionSchema);
export default Session;
