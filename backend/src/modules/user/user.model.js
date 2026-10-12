/**
 * User collection.
 *
 * MODELING DECISIONS
 *
 * 1. Credentials live on the user document, not in a separate collection.
 *    Cardinality is 1:1 and they are read together on every login, so splitting
 *    them would mean two round trips for zero benefit. The risk of embedding a
 *    secret — accidentally serializing it into a response — is handled
 *    structurally by `select: false` plus the toJSON transform below, not by
 *    remembering to omit it at each call site.
 *
 * 2. `username` is stored already-lowercased and is the unique key.
 *    The alternative, a case-insensitive unique index via collation, works but
 *    surprises people: the index is only used when the query *also* specifies
 *    the same collation, so a plain `findOne({username})` silently does a
 *    collection scan. Normalizing on write keeps lookups trivially indexed, at
 *    the cost of not preserving the user's preferred casing — which is what
 *    `displayName` is for.
 *
 * 3. `collegeDomain` is derived from the email domain at registration.
 *    CollegeGram is college-scoped, so "posts from my college" is a primary
 *    access pattern. Deriving and storing the domain means that query is a
 *    single indexed equality match rather than a regex over email addresses,
 *    which could not use an index efficiently. It is denormalized data, but
 *    from an immutable source: the email domain cannot change without changing
 *    the email, which is a deliberate account operation.
 *
 * 4. Counters (`reputation`) live here rather than being computed on read.
 *    Computing reputation by aggregating every vote a user ever received would
 *    be an unbounded scan on every profile view. Maintained incrementally with
 *    atomic $inc instead — see Phase 6. Consequence: it is eventually
 *    consistent and can drift if a process dies mid-update, so it is a display
 *    value and never an authorization input.
 */
import mongoose from "mongoose";

export const ROLES = Object.freeze({
  USER: "user",
  MODERATOR: "moderator",
  ADMIN: "admin",
});

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      maxlength: 254, // RFC 5321 maximum
    },

    username: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
      minlength: 3,
      maxlength: 30,
    },

    displayName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 60,
    },

    /**
     * bcrypt output. `select: false` omits it from every query by default, so
     * code must opt in explicitly (`.select("+passwordHash")`). This means a
     * forgotten `.select()` fails closed — the field is absent — rather than
     * failing open by leaking the hash into a response.
     */
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },

    collegeDomain: {
      type: String,
      lowercase: true,
      trim: true,
      maxlength: 253,
    },

    bio: { type: String, trim: true, maxlength: 280, default: "" },

    role: {
      type: String,
      enum: Object.values(ROLES),
      default: ROLES.USER,
      // Note: `role` is never accepted from a request body. Zod schemas do not
      // declare it, so mass assignment cannot set it (see middleware/validate.js).
    },

    reputation: { type: Number, default: 0, min: 0 },

    /**
     * Soft-delete / moderation state. A hard delete would orphan every post and
     * comment the user wrote and break threads for everyone else; disabling the
     * account preserves referential integrity.
     */
    status: {
      type: String,
      enum: ["active", "suspended", "deleted"],
      default: "active",
    },
  },
  {
    timestamps: true, // createdAt / updatedAt, maintained by mongoose
    toJSON: {
      /**
       * The last line of defence against leaking secrets. Even if a query
       * explicitly selects passwordHash, res.json(user) will not expose it.
       */
      transform(_doc, ret) {
        ret.id = ret._id?.toString();
        delete ret._id;
        delete ret.__v;
        delete ret.passwordHash;
        return ret;
      },
    },
  }
);

/**
 * INDEXES
 *
 * The two unique indexes are not merely a performance optimization — they are
 * the *correctness* mechanism for duplicate-account prevention. A service-layer
 * "check if email exists, then insert" is a classic time-of-check/time-of-use
 * race: two concurrent registrations both find nothing and both insert. Only a
 * unique index can reject the loser, and the service translates that
 * E11000 duplicate-key error into a clean 409. See docs/CONCURRENCY.md.
 */
userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ username: 1 }, { unique: true });

// Supports "members of my college, newest first", the profile-discovery query.
// Compound order matters: equality field first, then the sort field, so Mongo
// can seek to the collegeDomain and walk createdAt in order without an
// in-memory sort.
userSchema.index({ collegeDomain: 1, createdAt: -1 });

export const User = mongoose.model("User", userSchema);
export default User;
