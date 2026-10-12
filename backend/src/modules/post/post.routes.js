/**
 * Post routes.
 *
 * MIDDLEWARE ORDER PER ROUTE, and why it is always this order:
 *   rateLimit → authenticate → validate → controller
 *
 *   The limiter runs FIRST so that an unauthenticated flood is rejected before
 *   it costs us a JWT verification or a database read. Authentication runs
 *   before validation so an anonymous caller gets 401 rather than a 400 that
 *   leaks which fields the endpoint accepts.
 *
 * RATE LIMITS ARE PER-ENDPOINT BY WRITE COST, not one global number. Creating
 * a post allocates storage and lands in everyone's feed; voting is one $inc.
 * A single limit generous enough for voting would be far too generous for
 * posting, and a limit strict enough for posting would break normal browsing.
 */
import { Router } from "express";
import validate from "../../middleware/validate.js";
import rateLimit from "../../middleware/rateLimit.js";
import { authenticate, optionalAuth } from "../../middleware/authenticate.js";
import {
  createPostSchema,
  postIdSchema,
  feedQuerySchema,
  voteSchema,
  createCommentSchema,
  listCommentsSchema,
} from "./post.schemas.js";
import * as controller from "./post.controller.js";

const router = Router();

router.post(
  "/",
  rateLimit({ scope: "post:create", limit: 10, windowSeconds: 60 * 60 }),
  authenticate,
  validate(createPostSchema),
  controller.create
);

/**
 * `optionalAuth` rather than `authenticate`: the feed is readable without an
 * account, but a signed-in viewer additionally gets `myVote` on each row. One
 * route, two behaviours, no duplicated query.
 */
router.get(
  "/",
  rateLimit({ scope: "feed", limit: 120, windowSeconds: 60 }),
  optionalAuth,
  validate(feedQuerySchema),
  controller.feed
);

router.get("/:postId", optionalAuth, validate(postIdSchema), controller.getOne);

router.delete("/:postId", authenticate, validate(postIdSchema), controller.remove);

router.post(
  "/:postId/vote",
  rateLimit({ scope: "vote", limit: 60, windowSeconds: 60 }),
  authenticate,
  validate(voteSchema),
  controller.vote
);

router.post(
  "/:postId/comments",
  rateLimit({ scope: "comment:create", limit: 30, windowSeconds: 60 * 60 }),
  authenticate,
  validate(createCommentSchema),
  controller.createComment
);

router.get("/:postId/comments", optionalAuth, validate(listCommentsSchema), controller.listComments);

export default router;
