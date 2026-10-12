/**
 * Comment model — deliberately flat (one level), not a tree.
 *
 * Arbitrary nesting is where comment systems go to die: you either recurse
 * once per level (N+1 queries), store a materialized path and pay for string
 * prefix scans, or pull the whole thread and assemble it in memory. All three
 * are defensible at scale and all three are over-engineering for this project.
 * Flat comments need one index and one query, and the schema below can grow a
 * `parentId` later without a migration of existing rows.
 */
import mongoose from "mongoose";

const commentSchema = new mongoose.Schema(
  {
    postId: { type: mongoose.Schema.Types.ObjectId, ref: "Post", required: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    body: { type: String, required: true, trim: true, maxlength: 2_000 },
    status: { type: String, enum: ["active", "deleted"], default: "active" },
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

// The only read pattern: a page of one post's comments, newest first, with
// `_id` as the cursor tie-breaker. Same ESR reasoning as the feed indexes.
commentSchema.index({ postId: 1, status: 1, createdAt: -1, _id: -1 });

export const Comment = mongoose.model("Comment", commentSchema);
export default Comment;
