import { z } from "zod";
import { POST_SORTS } from "./post.model.js";

/**
 * A 24-hex-character ObjectId, validated at the edge.
 *
 * Without this, `/posts/garbage` reaches mongoose, throws a CastError, and is
 * reported as a 400 by the error handler — the right status by accident. With
 * it, the rejection happens before any database work and the message names the
 * offending field.
 */
const objectId = z.string().regex(/^[a-f0-9]{24}$/i, "Must be a valid id");

export const createPostSchema = {
  body: z.object({
    title: z.string().trim().min(5, "Title must be at least 5 characters").max(200),
    body: z.string().trim().min(1, "Body is required").max(10_000),
  }),
};

export const postIdSchema = { params: z.object({ postId: objectId }) };

export const feedQuerySchema = {
  query: z.object({
    sort: z.enum([POST_SORTS.NEW, POST_SORTS.TOP]).default(POST_SORTS.NEW),
    // An unbounded `limit` is a denial-of-service vector: `?limit=1000000`
    // would ask Mongo for the whole collection and serialize it into memory.
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(200).optional(),
    // Defaults to the viewer's own college in the controller.
    college: z.string().trim().toLowerCase().max(253).optional(),
  }),
};

export const voteSchema = {
  params: z.object({ postId: objectId }),
  // 0 means "remove my vote", which keeps one endpoint instead of a DELETE
  // that would need its own route, limiter and tests.
  body: z.object({ value: z.union([z.literal(1), z.literal(-1), z.literal(0)]) }),
};

export const createCommentSchema = {
  params: z.object({ postId: objectId }),
  body: z.object({ body: z.string().trim().min(1, "Comment cannot be empty").max(2_000) }),
};

export const listCommentsSchema = {
  params: z.object({ postId: objectId }),
  query: z.object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: z.string().max(200).optional(),
  }),
};
