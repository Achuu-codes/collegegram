/**
 * Vote model — one row per (user, post).
 *
 * THE UNIQUE COMPOUND INDEX IS THE ENTIRE CONCURRENCY DESIGN.
 *   "A user may vote on a post at most once" cannot be enforced in application
 *   code. `if (!await Vote.findOne(...)) await Vote.create(...)` is a
 *   time-of-check/time-of-use race: two simultaneous requests both see no
 *   existing vote, both insert, and the post's score is now inflated by a
 *   double vote that no amount of later reading can detect.
 *
 *   The database is the only component that can arbitrate, because it is the
 *   only one with a serialization point. The unique index gives us that: one
 *   insert wins, the other fails with E11000, and we handle it as "already
 *   voted". No locks, no transactions, no Redlock — a single-document atomic
 *   operation against a constraint.
 *
 * `value` is +1 or -1 only. A removed vote deletes the row rather than storing
 * 0: a zero row is a tombstone that still occupies the unique slot, and every
 * query would then need `value: { $ne: 0 }`.
 */
import mongoose from "mongoose";

const voteSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    postId: { type: mongoose.Schema.Types.ObjectId, ref: "Post", required: true },
    value: { type: Number, required: true, enum: [1, -1] },
  },
  { timestamps: true }
);

voteSchema.index({ userId: 1, postId: 1 }, { unique: true });
// Supports "which of these posts have I voted on?" for a feed page, and the
// reconciliation job's per-post sum.
voteSchema.index({ postId: 1, userId: 1 });

export const Vote = mongoose.model("Vote", voteSchema);
export default Vote;
