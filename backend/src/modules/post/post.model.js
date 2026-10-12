/**
 * Post model.
 *
 * TWO DELIBERATELY DENORMALIZED FIELDS — `score` and `commentCount`.
 *   The normalized alternative is to count votes and comments on read:
 *   `Vote.countDocuments({ postId })` for every post on every feed page. For a
 *   20-post page that is 40 extra queries, each one scanning every vote on the
 *   post. Feeds are read overwhelmingly more often than they are written, so we
 *   pay a tiny cost on write (`$inc`) to make the read a single index hit.
 *
 *   The price is that these counters can drift from the vote collection if a
 *   process dies between the two writes (see post.service.js — we do the
 *   authoritative write first, so drift means a *stale counter*, never a lost
 *   vote). They are a cache, and `Vote` remains the source of truth, which is
 *   what makes a periodic reconciliation job possible.
 *
 * `collegeDomain` is copied from the author at creation time rather than joined
 * on read. It is the feed's partition key, and a $lookup into users on every
 * feed query would defeat the compound index below. Copying an immutable-ish
 * value is the right trade; a *mutable* one (e.g. displayName) would not be.
 */
import mongoose from "mongoose";

export const POST_SORTS = Object.freeze({ NEW: "new", TOP: "top" });

const postSchema = new mongoose.Schema(
  {
    authorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true, // "posts by this user", and the author's profile page
    },

    collegeDomain: { type: String, required: true, lowercase: true, trim: true },

    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, trim: true, maxlength: 10_000 },

    score: { type: Number, default: 0 },
    commentCount: { type: Number, default: 0, min: 0 },

    // Soft delete. A hard delete would orphan comments and votes, and would
    // make moderation un-auditable; the feed filters on this instead.
    status: { type: String, enum: ["active", "deleted"], default: "active" },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    toJSON: {
      transform(_doc, ret) {
        ret.id = ret._id?.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  }
);

/**
 * THE TWO FEED INDEXES. Field order follows ESR (Equality, Sort, Range):
 * the equality predicates come first so the index narrows to one college's
 * active posts, then the sort key, then `_id` as the cursor tie-breaker. With
 * this order MongoDB can satisfy filter + sort + pagination from the index
 * alone — no in-memory sort stage, which is also what keeps it under the 32MB
 * blocking-sort limit on a large collection.
 *
 * Reversing the order (sort key first) would force a scan of every post ever
 * written to find the ones from this college. Verified with explain(); the
 * command and output are in docs/PERFORMANCE.md.
 */
postSchema.index({ collegeDomain: 1, status: 1, createdAt: -1, _id: -1 });
postSchema.index({ collegeDomain: 1, status: 1, score: -1, _id: -1 });

export const Post = mongoose.model("Post", postSchema);
export default Post;
