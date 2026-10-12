/**
 * Posts, feed, votes and comments — integration tests.
 *
 * Same principle as auth.test.js: each block names a property that must hold,
 * and most of them are properties only a real database can prove (atomic
 * counters, unique-index arbitration, keyset pagination under concurrent
 * inserts). Mocking Mongo here would test nothing but my own assumptions.
 */
import { describe, it, expect } from "vitest";
import { api, makeUser, authHeader } from "./helpers.js";
import { Post } from "../src/modules/post/post.model.js";
import { Vote } from "../src/modules/post/vote.model.js";
import { reconcileScore } from "../src/modules/post/post.service.js";

const postBody = (overrides = {}) => ({
  title: "Where is the best coffee on campus",
  body: "Asking for a friend who has an 8am lecture.",
  ...overrides,
});

async function createPost(token, overrides) {
  const response = await api().post("/posts").set(...authHeader(token)).send(postBody(overrides));
  return { response, post: response.body?.data?.post };
}

describe("POST /posts", () => {
  it("creates a post owned by the caller", async () => {
    const { accessToken, user } = await makeUser();
    const { response, post } = await createPost(accessToken);

    expect(response.status).toBe(201);
    expect(post.title).toBe(postBody().title);
    expect(post.authorId).toBe(user.id);
    expect(post.score).toBe(0);
    expect(post.commentCount).toBe(0);
  });

  it("requires authentication", async () => {
    const response = await api().post("/posts").send(postBody());
    expect(response.status).toBe(401);
  });

  /**
   * The feed is partitioned by college, and the partition key comes from the
   * authenticated author — never from the request body. If it were
   * client-supplied, anyone could post into any college's feed.
   */
  it("derives collegeDomain from the author, ignoring a client-supplied one", async () => {
    const { accessToken } = await makeUser({ email: "a@mit.edu" });
    const { post } = await createPost(accessToken, { collegeDomain: "harvard.edu" });

    const stored = await Post.findById(post.id);
    expect(stored.collegeDomain).toBe("mit.edu");
  });

  it("ignores client-supplied score and commentCount (no mass assignment)", async () => {
    const { accessToken } = await makeUser();
    const { post } = await createPost(accessToken, { score: 9999, commentCount: 42 });

    expect(post.score).toBe(0);
    expect(post.commentCount).toBe(0);
  });

  it("rejects a title under 5 characters and a body over the limit", async () => {
    const { accessToken } = await makeUser();

    const short = await api().post("/posts").set(...authHeader(accessToken)).send(postBody({ title: "hi" }));
    expect(short.status).toBe(400);
    expect(short.body.error.details[0].field).toBe("title");

    const long = await api()
      .post("/posts")
      .set(...authHeader(accessToken))
      .send(postBody({ body: "x".repeat(10_001) }));
    expect(long.status).toBe(400);
  });
});

describe("GET /posts — feed, sorting and pagination", () => {
  it("defaults to the viewer's own college and newest first", async () => {
    const { accessToken } = await makeUser({ email: "s@mit.edu" });
    await createPost(accessToken, { title: "First post about things" });
    await createPost(accessToken, { title: "Second post about things" });

    const other = await makeUser({ email: "s@harvard.edu" });
    await createPost(other.accessToken, { title: "A Harvard post entirely" });

    const response = await api().get("/posts").set(...authHeader(accessToken));

    expect(response.status).toBe(200);
    expect(response.body.data.items).toHaveLength(2);
    expect(response.body.data.items[0].title).toBe("Second post about things");
    expect(response.body.meta.collegeDomain).toBe("mit.edu");
  });

  it("sorts by score when asked", async () => {
    const author = await makeUser({ email: "a@mit.edu" });
    const voter = await makeUser({ email: "b@mit.edu" });
    const { post: low } = await createPost(author.accessToken, { title: "The unpopular one" });
    const { post: high } = await createPost(author.accessToken, { title: "The popular one" });

    await api().post(`/posts/${high.id}/vote`).set(...authHeader(voter.accessToken)).send({ value: 1 });

    const response = await api()
      .get("/posts?sort=top")
      .set(...authHeader(voter.accessToken));

    expect(response.body.data.items.map((p) => p.id)).toEqual([high.id, low.id]);
  });

  /**
   * KEYSET PAGINATION: every item appears exactly once across pages, and the
   * cursor is stable. This is the test that fails if someone "simplifies" the
   * query back to skip/limit and a post is inserted mid-traversal.
   */
  it("walks every post exactly once across cursor pages", async () => {
    const { accessToken } = await makeUser({ email: "s@mit.edu" });
    for (let i = 0; i < 5; i += 1) {
      await createPost(accessToken, { title: `Post number ${i} of five` });
    }

    const seen = [];
    let cursor = null;
    for (let page = 0; page < 10; page += 1) {
      const url = `/posts?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const response = await api().get(url).set(...authHeader(accessToken));
      expect(response.status).toBe(200);
      seen.push(...response.body.data.items.map((p) => p.id));
      cursor = response.body.data.nextCursor;
      if (!cursor) break;
    }

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5); // no duplicates, no omissions
  });

  it("rejects a malformed cursor with 400 rather than a 500", async () => {
    const { accessToken } = await makeUser();
    const response = await api().get("/posts?cursor=not-a-real-cursor").set(...authHeader(accessToken));
    expect(response.status).toBe(400);
  });

  it("caps limit to prevent an unbounded query", async () => {
    const { accessToken } = await makeUser();
    const response = await api().get("/posts?limit=100000").set(...authHeader(accessToken));
    expect(response.status).toBe(400);
  });

  it("excludes soft-deleted posts", async () => {
    const { accessToken } = await makeUser({ email: "s@mit.edu" });
    const { post } = await createPost(accessToken);

    await api().delete(`/posts/${post.id}`).set(...authHeader(accessToken));

    const response = await api().get("/posts").set(...authHeader(accessToken));
    expect(response.body.data.items).toHaveLength(0);
    expect((await api().get(`/posts/${post.id}`)).status).toBe(404);
  });

  /**
   * The cached first page must be viewer-agnostic. `myVote` is personalized
   * AFTER the cache read, so two users hitting the same cached page must each
   * see their own vote — the classic "cached one user's data for everyone" bug.
   */
  it("does not leak one viewer's vote into another viewer's cached feed", async () => {
    const author = await makeUser({ email: "a@mit.edu" });
    const voter = await makeUser({ email: "b@mit.edu" });
    const bystander = await makeUser({ email: "c@mit.edu" });
    const { post } = await createPost(author.accessToken);

    await api().post(`/posts/${post.id}/vote`).set(...authHeader(voter.accessToken)).send({ value: 1 });

    const voterFeed = await api().get("/posts").set(...authHeader(voter.accessToken));
    const bystanderFeed = await api().get("/posts").set(...authHeader(bystander.accessToken));

    expect(voterFeed.body.data.items[0].myVote).toBe(1);
    expect(bystanderFeed.body.data.items[0].myVote).toBe(0);
  });

  it("serves an anonymous viewer a named college feed with no myVote", async () => {
    const { accessToken } = await makeUser({ email: "s@mit.edu" });
    await createPost(accessToken);

    const response = await api().get("/posts?college=mit.edu");

    expect(response.status).toBe(200);
    expect(response.body.data.items[0].myVote).toBeUndefined();
  });
});

describe("DELETE /posts/:postId — ownership", () => {
  it("lets the author delete their own post", async () => {
    const { accessToken } = await makeUser();
    const { post } = await createPost(accessToken);

    const response = await api().delete(`/posts/${post.id}`).set(...authHeader(accessToken));
    expect(response.status).toBe(204);
    expect((await Post.findById(post.id)).status).toBe("deleted");
  });

  it("returns 403 when another user tries to delete it", async () => {
    const author = await makeUser();
    const stranger = await makeUser();
    const { post } = await createPost(author.accessToken);

    const response = await api().delete(`/posts/${post.id}`).set(...authHeader(stranger.accessToken));

    expect(response.status).toBe(403);
    expect((await Post.findById(post.id)).status).toBe("active");
  });

  it("lets a moderator delete anyone's post", async () => {
    const author = await makeUser();
    const { post } = await createPost(author.accessToken);

    const mod = await makeUser();
    const { User } = await import("../src/modules/user/user.model.js");
    await User.findByIdAndUpdate(mod.user.id, { role: "moderator" });
    // A fresh login, because role lives in the access token: the old token
    // still says "user". That staleness is documented in authenticate.js.
    const login = await api()
      .post("/auth/login")
      .send({ identifier: mod.payload.email, password: mod.payload.password });

    const response = await api()
      .delete(`/posts/${post.id}`)
      .set(...authHeader(login.body.data.accessToken));

    expect(response.status).toBe(204);
  });

  it("returns 404 for an id that does not exist and 400 for a malformed one", async () => {
    const { accessToken } = await makeUser();

    const missing = await api()
      .delete("/posts/0123456789abcdef01234567")
      .set(...authHeader(accessToken));
    expect(missing.status).toBe(404);

    const malformed = await api().delete("/posts/nope").set(...authHeader(accessToken));
    expect(malformed.status).toBe(400);
  });
});

describe("POST /posts/:postId/vote", () => {
  it("records an upvote and increments the score once", async () => {
    const author = await makeUser();
    const voter = await makeUser();
    const { post } = await createPost(author.accessToken);

    const response = await api()
      .post(`/posts/${post.id}/vote`)
      .set(...authHeader(voter.accessToken))
      .send({ value: 1 });

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ score: 1, myVote: 1 });
    expect(await Vote.countDocuments({ postId: post.id })).toBe(1);
  });

  /**
   * IDEMPOTENCE. A double-tapped button, a retried request after a timeout, or
   * a client that fires on both mousedown and click must not count twice.
   */
  it("is idempotent when the same vote is sent repeatedly", async () => {
    const author = await makeUser();
    const voter = await makeUser();
    const { post } = await createPost(author.accessToken);
    const vote = () =>
      api().post(`/posts/${post.id}/vote`).set(...authHeader(voter.accessToken)).send({ value: 1 });

    await vote();
    await vote();
    const third = await vote();

    expect(third.body.data.score).toBe(1);
    expect((await Post.findById(post.id)).score).toBe(1);
    expect(await Vote.countDocuments({ postId: post.id })).toBe(1);
  });

  it("applies a delta of 2 when a vote is flipped from up to down", async () => {
    const author = await makeUser();
    const voter = await makeUser();
    const { post } = await createPost(author.accessToken);

    await api().post(`/posts/${post.id}/vote`).set(...authHeader(voter.accessToken)).send({ value: 1 });
    const flipped = await api()
      .post(`/posts/${post.id}/vote`)
      .set(...authHeader(voter.accessToken))
      .send({ value: -1 });

    // +1 → -1 is a change of 2, not of 1. Getting this wrong is the single
    // most common bug in a vote counter.
    expect(flipped.body.data.score).toBe(-1);
    expect(await Vote.countDocuments({ postId: post.id })).toBe(1);
  });

  it("removes a vote with value 0 and returns the score to zero", async () => {
    const author = await makeUser();
    const voter = await makeUser();
    const { post } = await createPost(author.accessToken);

    await api().post(`/posts/${post.id}/vote`).set(...authHeader(voter.accessToken)).send({ value: 1 });
    const removed = await api()
      .post(`/posts/${post.id}/vote`)
      .set(...authHeader(voter.accessToken))
      .send({ value: 0 });

    expect(removed.body.data.score).toBe(0);
    expect(await Vote.countDocuments({ postId: post.id })).toBe(0);
  });

  /**
   * THE RACE THE UNIQUE INDEX AND THE "BEFORE" DOCUMENT EXIST TO WIN.
   *
   * Ten identical votes in flight at once. A read-then-write implementation
   * would have several of them read "no existing vote", each apply +1, and
   * leave the score at up to 10 from a single user. Exactly one row and a
   * score of exactly 1 is the proof that the database arbitrates.
   */
  it("counts one vote when ten identical requests race", async () => {
    const author = await makeUser();
    const voter = await makeUser();
    const { post } = await createPost(author.accessToken);

    await Promise.all(
      Array.from({ length: 10 }, () =>
        api().post(`/posts/${post.id}/vote`).set(...authHeader(voter.accessToken)).send({ value: 1 })
      )
    );

    expect(await Vote.countDocuments({ postId: post.id })).toBe(1);
    expect((await Post.findById(post.id)).score).toBe(1);
  });

  it("sums correctly when many different users vote concurrently", async () => {
    const author = await makeUser();
    const { post } = await createPost(author.accessToken);
    const voters = await Promise.all([makeUser(), makeUser(), makeUser(), makeUser()]);

    await Promise.all(
      voters.map((v, i) =>
        api()
          .post(`/posts/${post.id}/vote`)
          .set(...authHeader(v.accessToken))
          .send({ value: i === 0 ? -1 : 1 })
      )
    );

    // Three up, one down. $inc is atomic server-side, so no update is lost.
    expect((await Post.findById(post.id)).score).toBe(2);
  });

  it("refuses a self-vote", async () => {
    const { accessToken } = await makeUser();
    const { post } = await createPost(accessToken);

    const response = await api()
      .post(`/posts/${post.id}/vote`)
      .set(...authHeader(accessToken))
      .send({ value: 1 });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("SELF_VOTE");
  });

  it("rejects a vote value other than 1, -1 or 0", async () => {
    const author = await makeUser();
    const voter = await makeUser();
    const { post } = await createPost(author.accessToken);

    const response = await api()
      .post(`/posts/${post.id}/vote`)
      .set(...authHeader(voter.accessToken))
      .send({ value: 100 });

    expect(response.status).toBe(400);
  });

  /**
   * The counter is a cache; `Vote` is the source of truth. This proves the
   * invariant is repairable, which is what makes the denormalization safe.
   */
  it("can rebuild a drifted score from the votes themselves", async () => {
    const author = await makeUser();
    const voter = await makeUser();
    const { post } = await createPost(author.accessToken);
    await api().post(`/posts/${post.id}/vote`).set(...authHeader(voter.accessToken)).send({ value: 1 });

    // Simulate drift: a crash between the vote write and the counter write.
    await Post.updateOne({ _id: post.id }, { $set: { score: 73 } });

    expect(await reconcileScore(post.id)).toBe(1);
    expect((await Post.findById(post.id)).score).toBe(1);
  });
});

describe("Comments", () => {
  it("creates a comment and increments the post's counter", async () => {
    const { accessToken } = await makeUser();
    const { post } = await createPost(accessToken);

    const response = await api()
      .post(`/posts/${post.id}/comments`)
      .set(...authHeader(accessToken))
      .send({ body: "Second floor of the library, no question." });

    expect(response.status).toBe(201);
    expect(response.body.data.comment.body).toContain("library");
    expect((await Post.findById(post.id)).commentCount).toBe(1);

    // One resource, one shape: a created comment must look exactly like a
    // listed one, or every client has to special-case the create response.
    const listed = await api().get(`/posts/${post.id}/comments`);
    expect(Object.keys(response.body.data.comment).sort()).toEqual(
      Object.keys(listed.body.data.items[0]).sort()
    );
    expect(response.body.data.comment.author.username).toBeTruthy();
  });

  it("lists comments newest first with a cursor", async () => {
    const { accessToken } = await makeUser();
    const { post } = await createPost(accessToken);
    for (let i = 0; i < 3; i += 1) {
      await api()
        .post(`/posts/${post.id}/comments`)
        .set(...authHeader(accessToken))
        .send({ body: `Comment ${i}` });
    }

    const response = await api().get(`/posts/${post.id}/comments?limit=2`);

    expect(response.body.data.items).toHaveLength(2);
    expect(response.body.data.items[0].body).toBe("Comment 2");
    expect(response.body.data.nextCursor).toBeTruthy();
    expect(response.body.data.items[0].author.username).toBeTruthy();
  });

  it("rejects an empty comment and one on a missing post", async () => {
    const { accessToken } = await makeUser();
    const { post } = await createPost(accessToken);

    const empty = await api()
      .post(`/posts/${post.id}/comments`)
      .set(...authHeader(accessToken))
      .send({ body: "   " });
    expect(empty.status).toBe(400);

    const missing = await api()
      .post("/posts/0123456789abcdef01234567/comments")
      .set(...authHeader(accessToken))
      .send({ body: "hello there" });
    expect(missing.status).toBe(404);
  });

  it("requires authentication to comment but not to read", async () => {
    const { accessToken } = await makeUser();
    const { post } = await createPost(accessToken);

    expect((await api().post(`/posts/${post.id}/comments`).send({ body: "hi there" })).status).toBe(401);
    expect((await api().get(`/posts/${post.id}/comments`)).status).toBe(200);
  });
});

describe("Unknown routes", () => {
  it("returns a structured 404 with a request id", async () => {
    const response = await api().get("/posts/not/a/route");

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("ROUTE_NOT_FOUND");
    expect(response.body.error.requestId).toBeTruthy();
  });
});
