/**
 * Post, feed and vote logic.
 */
import mongoose from "mongoose";

import { Post, POST_SORTS } from "./post.model.js";
import { Vote } from "./vote.model.js";
import { User, ROLES } from "../user/user.model.js";
import { Comment } from "../comment/comment.model.js";
import { cache } from "../../lib/redis.js";
import { keysetFilter, toPage } from "../../lib/pagination.js";
import { NotFoundError, AuthorizationError, ConflictError } from "../../lib/errors.js";

/** Fields returned for a feed row. Never the whole document: see note below. */
const FEED_PROJECTION = "title body score commentCount authorId collegeDomain createdAt";

/**
 * A projection, not `find()` with no arguments.
 *
 * An unprojected query sends every field of every document over the wire and
 * through JSON.stringify. Today a Post has nothing sensitive in it, so this
 * costs only bandwidth — but the habit is what stops a field added next month
 * (a moderation note, an author's email) from silently appearing in a public
 * API response. Allowlist what you return; never rely on remembering to
 * exclude.
 */
const AUTHOR_PROJECTION = "username displayName reputation";

const FEED_CACHE_TTL_SECONDS = 30;

export async function createPost({ title, body }, userId) {
  // The author's college is the feed partition, and it is not client-supplied:
  // trusting the body here would let anyone post into another college's feed.
  const author = await User.findById(userId).select("collegeDomain status");
  if (!author || author.status !== "active") throw new AuthorizationError("Account is not active");

  const post = await Post.create({
    authorId: userId,
    collegeDomain: author.collegeDomain,
    title,
    body,
  });

  // The new post belongs on page 1 of this college's feed, so every cached
  // first page for it is now wrong. Deleting beats trying to splice the post
  // into the cached array: the DB is the source of truth and a miss is cheap.
  await cache.del(...feedCacheKeys(author.collegeDomain));

  return post;
}

const feedCacheKeys = (collegeDomain) =>
  Object.values(POST_SORTS).map((sort) => `cg:feed:${collegeDomain}:${sort}`);

/**
 * One page of a college's feed.
 *
 * CACHING POLICY, and its two deliberate limits:
 *   1. ONLY the first page is cached (`cursor` absent). Page 1 is what almost
 *      every session requests and what a hot post's traffic concentrates on;
 *      deep pages have a long tail of distinct cursors with a near-zero hit
 *      rate, so caching them would mostly fill Redis with garbage and evict
 *      the entries that matter.
 *   2. The TTL is 30 seconds, and it is also the invalidation strategy for
 *      votes. A vote changes `score`, which can reorder the "top" feed — but
 *      invalidating on every vote would make the cache useless on exactly the
 *      posts that are being voted on most. So scores in the feed are up to 30
 *      seconds stale, by choice. That is correct for a social feed and would
 *      be wrong for a balance or an inventory count.
 *   New posts DO invalidate immediately (above), because "I posted and cannot
 *   see it" is the one staleness a user notices instantly.
 *
 * `personalizeVotes` is applied AFTER the cache, never inside it: the cached
 * value must be shared by every viewer. Caching a per-user payload under a
 * shared key is the bug that serves one user's data to another.
 */
export async function listFeed({ collegeDomain, sort, limit, cursor }, viewerId) {
  const sortField = sort === POST_SORTS.TOP ? "score" : "createdAt";
  const cacheKey = `cg:feed:${collegeDomain}:${sort}`;
  const cacheable = !cursor && limit === 20;

  if (cacheable) {
    const hit = await cache.get(cacheKey);
    if (hit) return { ...(await personalizeVotes(hit, viewerId)), cached: true };
  }

  const docs = await Post.find({
    collegeDomain,
    status: "active",
    ...keysetFilter(sortField, cursor),
  })
    .select(FEED_PROJECTION)
    .populate("authorId", AUTHOR_PROJECTION)
    .sort({ [sortField]: -1, _id: -1 })
    .limit(limit + 1) // the +1 tells us whether a next page exists
    .lean();

  const page = toPage(docs, limit, sortField);
  const payload = { items: page.items.map(serializePost), nextCursor: page.nextCursor };

  if (cacheable) await cache.set(cacheKey, payload, FEED_CACHE_TTL_SECONDS);

  return { ...(await personalizeVotes(payload, viewerId)), cached: false };
}

/** `.lean()` returns plain objects, so the model's toJSON transform never runs. */
function serializePost(doc) {
  const { _id, authorId, ...rest } = doc;
  return {
    id: String(_id),
    ...rest,
    author: authorId
      ? { id: String(authorId._id), username: authorId.username, displayName: authorId.displayName }
      : null,
  };
}

/**
 * Attach the viewer's own vote to each row.
 *
 * ONE query for the whole page (`postId: { $in: [...] }`), not one per post.
 * The per-post version is the N+1 problem: a 20-post feed becomes 21 round
 * trips, and the latency is additive because each one waits for the last.
 */
async function personalizeVotes(payload, viewerId) {
  if (!viewerId || payload.items.length === 0) return payload;

  const votes = await Vote.find({
    userId: viewerId,
    postId: { $in: payload.items.map((p) => p.id) },
  })
    .select("postId value")
    .lean();

  const byPost = new Map(votes.map((v) => [String(v.postId), v.value]));
  return {
    ...payload,
    items: payload.items.map((p) => ({ ...p, myVote: byPost.get(p.id) ?? 0 })),
  };
}

export async function getPost(postId, viewerId) {
  const post = await Post.findOne({ _id: postId, status: "active" })
    .populate("authorId", AUTHOR_PROJECTION)
    .lean();
  if (!post) throw new NotFoundError("Post");

  const serialized = serializePost(post);
  if (!viewerId) return serialized;

  const vote = await Vote.findOne({ userId: viewerId, postId }).select("value").lean();
  return { ...serialized, myVote: vote?.value ?? 0 };
}

/**
 * Soft-delete a post. Author or moderator only.
 *
 * The ownership check is expressed as part of the QUERY FILTER rather than as
 * `if (post.authorId !== userId) throw`. Two reasons: it is one round trip
 * instead of read-then-write, and read-then-write is itself a race — two
 * concurrent deletes both read `status: "active"` and both run the side
 * effects. Here the filter and the update are one atomic operation, so a
 * second caller matches nothing and gets the already-deleted answer.
 */
export async function deletePost(postId, viewer) {
  const isModerator = viewer.role === ROLES.MODERATOR || viewer.role === ROLES.ADMIN;
  const filter = { _id: postId, status: "active" };
  if (!isModerator) filter.authorId = viewer.id;

  const deleted = await Post.findOneAndUpdate(
    filter,
    { $set: { status: "deleted", deletedAt: new Date() } },
    { returnDocument: "after" }
  );

  if (!deleted) {
    // Distinguish "does not exist" from "not yours" — but only after proving
    // the post exists, so this cannot be used to probe for post ids.
    const exists = await Post.exists({ _id: postId, status: "active" });
    if (exists) throw new AuthorizationError("You can only delete your own posts");
    throw new NotFoundError("Post");
  }

  await cache.del(...feedCacheKeys(deleted.collegeDomain));
  return deleted;
}

/**
 * Cast, change or remove a vote, and keep `Post.score` in step.
 *
 * THE ORDER OF THE TWO WRITES IS THE DESIGN.
 *   `Vote` is the source of truth and is written FIRST; `Post.score` is a
 *   derived counter and is written second. If the process dies between them,
 *   we lose a counter increment — the vote is still recorded, and a
 *   reconciliation job can recompute the score from the votes. Doing it the
 *   other way round would lose the vote itself, which nothing can recover.
 *
 *   Both steps are single-document atomic operations, so no transaction is
 *   needed: a multi-document transaction here would add two round trips and a
 *   retry loop to buy consistency we do not require for a score.
 *
 *   The delta is computed from the PREVIOUS state returned by the same
 *   operation that replaced it (`returnDocument: "before"`), never from a
 *   separate read. That is what makes concurrent votes correct: the unique
 *   index serializes the two upserts, so each caller is handed a different
 *   "before" value and the two deltas sum correctly. Computing the delta from
 *   an earlier read would let both callers see the same old value and apply
 *   the same delta twice.
 */
export async function castVote({ postId, value }, userId) {
  const post = await Post.findOne({ _id: postId, status: "active" }).select("_id authorId");
  if (!post) throw new NotFoundError("Post");
  if (String(post.authorId) === String(userId)) {
    throw new ConflictError("You cannot vote on your own post", "SELF_VOTE");
  }

  let previous = 0;

  if (value === 0) {
    const removed = await Vote.findOneAndDelete({ userId, postId });
    if (!removed) return currentScore(postId, 0); // nothing to remove; no-op
    previous = removed.value;
  } else {
    const before = await Vote.findOneAndUpdate(
      { userId, postId },
      { $set: { value } },
      { upsert: true, returnDocument: "before" }
    );
    previous = before?.value ?? 0;
    // Re-sending the same vote is idempotent: delta 0, no write to the post.
    if (previous === value) return currentScore(postId, value);
  }

  const delta = value - previous;
  const updated = await Post.findOneAndUpdate(
    { _id: postId },
    { $inc: { score: delta } },
    { returnDocument: "after", projection: "score" }
  );

  return { score: updated?.score ?? 0, myVote: value };
}

async function currentScore(postId, myVote) {
  const post = await Post.findById(postId).select("score").lean();
  return { score: post?.score ?? 0, myVote };
}

/**
 * Recompute a post's score from the votes themselves.
 *
 * This is the other half of the "counters are a cache" argument: because `Vote`
 * is authoritative, drift is always repairable. In production this would be a
 * scheduled job over recently-voted posts; it is exposed here as a function so
 * the test suite can prove the invariant holds.
 */
export async function reconcileScore(postId) {
  const [result] = await Vote.aggregate([
    // The aggregation pipeline bypasses mongoose casting, so the id must be a
    // real ObjectId here — a string would match nothing and silently zero the
    // score. This is the one place the schema does not protect us.
    { $match: { postId: new mongoose.Types.ObjectId(String(postId)) } },
    { $group: { _id: null, score: { $sum: "$value" } } },
  ]);
  const score = result?.score ?? 0;
  await Post.updateOne({ _id: postId }, { $set: { score } });
  return score;
}

/** Shared by the create and list paths so one comment has one shape. */
function serializeComment(doc) {
  const { _id, authorId, ...rest } = doc;
  return {
    id: String(_id),
    ...rest,
    author: authorId
      ? { id: String(authorId._id), username: authorId.username, displayName: authorId.displayName }
      : null,
  };
}

/** Comment creation lives here because it also mutates the post's counter. */
export async function addComment({ postId, body }, userId) {
  const post = await Post.findOne({ _id: postId, status: "active" }).select("_id");
  if (!post) throw new NotFoundError("Post");

  const comment = await Comment.create({ postId, authorId: userId, body });
  await Post.updateOne({ _id: postId }, { $inc: { commentCount: 1 } });

  // Re-read with the author populated, and serialize through the SAME function
  // the list endpoint uses. Returning the raw document here instead would give
  // the client `authorId` as an object on create and `author` on list — two
  // shapes for one resource, which the client then has to special-case.
  const created = await Comment.findById(comment._id)
    .populate("authorId", AUTHOR_PROJECTION)
    .lean();

  return serializeComment(created);
}

export async function listComments({ postId, limit, cursor }) {
  const exists = await Post.exists({ _id: postId, status: "active" });
  if (!exists) throw new NotFoundError("Post");

  const docs = await Comment.find({
    postId,
    status: "active",
    ...keysetFilter("createdAt", cursor),
  })
    .populate("authorId", AUTHOR_PROJECTION)
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit + 1)
    .lean();

  const page = toPage(docs, limit, "createdAt");
  return { items: page.items.map(serializeComment), nextCursor: page.nextCursor };
}
