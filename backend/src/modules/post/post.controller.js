/**
 * Controllers are deliberately thin: read the (already validated) request,
 * call one service function, shape the response. No business logic, no
 * database access. That is what lets the service layer be tested without HTTP
 * and reused from a job or a CLI later.
 *
 * Note the absence of try/catch. Express 5 forwards a rejected promise from an
 * async handler to the error middleware automatically — one of the few genuine
 * behavioural differences from Express 4, where this would hang the request
 * forever and every handler needed a wrapper.
 */
import * as postService from "./post.service.js";
import { User } from "../user/user.model.js";
import { NotFoundError } from "../../lib/errors.js";

export async function create(req, res) {
  const post = await postService.createPost(req.body, req.user.id);
  res.status(201).json({ data: { post } });
}

export async function feed(req, res) {
  const { sort, limit, cursor, college } = req.validatedQuery;

  // A viewer sees their own college by default, and may name another
  // explicitly. Posts are public across colleges by product decision; if they
  // were not, this is the single line that would enforce it.
  let collegeDomain = college;
  if (!collegeDomain) {
    if (!req.user) throw new NotFoundError("College");
    const viewer = await User.findById(req.user.id).select("collegeDomain").lean();
    collegeDomain = viewer?.collegeDomain;
  }

  const page = await postService.listFeed(
    { collegeDomain, sort, limit, cursor },
    req.user?.id
  );

  res.json({ data: page, meta: { sort, collegeDomain, nextCursor: page.nextCursor } });
}

export async function getOne(req, res) {
  const post = await postService.getPost(req.params.postId, req.user?.id);
  res.json({ data: { post } });
}

export async function remove(req, res) {
  await postService.deletePost(req.params.postId, req.user);
  res.status(204).send();
}

export async function vote(req, res) {
  const result = await postService.castVote(
    { postId: req.params.postId, value: req.body.value },
    req.user.id
  );
  res.json({ data: result });
}

export async function createComment(req, res) {
  const comment = await postService.addComment(
    { postId: req.params.postId, body: req.body.body },
    req.user.id
  );
  res.status(201).json({ data: { comment } });
}

export async function listComments(req, res) {
  const page = await postService.listComments({
    postId: req.params.postId,
    ...req.validatedQuery,
  });
  res.json({ data: page, meta: { nextCursor: page.nextCursor } });
}
