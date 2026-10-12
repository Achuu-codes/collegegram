# Authorization

**Status note (honesty first):** sections 1–6 are implemented and covered by
tests. Lines describing unbuilt behaviour are still marked `[PLANNED]`, and
section 7 lists what does not exist. Nothing here claims more than the code
does.

---

## 1. Authentication vs authorization

They are distinct questions, answered by different layers, failing with
different status codes.

| | Authentication | Authorization |
|---|---|---|
| Question | "Who are you?" | "May you do this?" |
| Input | An access token | `req.user` + the target resource |
| Where | `middleware/authenticate.js` | Role middleware, then the service layer |
| Failure | **401** `TOKEN_MISSING` / `TOKEN_EXPIRED` / `TOKEN_INVALID` | **403** `FORBIDDEN` |
| Meaning of failure | "I don't know you — present credentials." | "I know exactly who you are. Still no." |

Returning 401 for an authorization failure is a common bug: it tells a correct
client to go re-authenticate, which it will do successfully, and then fail
again in a loop. The distinction is not pedantry — it changes client behaviour.

A subtle case already in the code: `POST /auth/login` against a **suspended**
account returns **403, not 401**, and only *after* the password is verified.
The password check comes first so that an anonymous attacker cannot learn an
account's status without proving they own it; the 403 then correctly says
"authenticated, not permitted."

## 2. The core principle

**Authorization is enforced on the server, on every request, with no exception.**

The frontend hides buttons the user may not use. That is a *usability*
feature and carries zero security weight. An attacker does not use your
frontend — they use `curl`, with a valid token for their own account, against
whatever URL they like. Any rule enforced only in React is not enforced.

Concretely, this is the attack the server must survive:

```
# Mallory holds a legitimate access token for her own account
curl -X DELETE https://api/posts/<alice's-post-id> \
     -H "Authorization: Bearer <mallory's-valid-token>"
```

She is perfectly *authenticated*. The only thing standing between her and
Alice's post is a server-side ownership check. This is **IDOR** — Insecure
Direct Object Reference — and it is one of the most common real-world API
vulnerabilities, because the request looks completely normal.

## 3. The role model

Three global roles, stored on the user document, carried in the access token:

| Role | Who | Capabilities |
|---|---|---|
| `user` | everyone, by default | Act on their own resources |
| `moderator` | appointed | Everything a user can, plus delete any post (implemented); delete any comment `[PLANNED]` |
| `admin` | operators | Everything a moderator can, plus suspending accounts `[PLANNED]` |

Deliberately **not** built: a general permission/capability system
(`can("post:delete")`), per-community moderator scoping, or role inheritance
hierarchies. Three flat roles cover every rule this application actually has.
A permission engine would be a large, abstract subsystem serving no present
requirement — the exact over-engineering the project brief rules out. If
per-college moderators are ever needed, the honest answer is that this model
would need to change, and that is a smaller cost than building for it now.

**Roles can never be set by a client.** `role` is absent from every Zod schema,
so the key is stripped from any request body before reaching the service layer
(`middleware/validate.js`). There is a test asserting that registering with
`{"role": "admin"}` produces an ordinary user.

### The staleness window — a real, accepted limitation

`authenticate` reads the role from the **token**, not the database, so an
authenticated request costs one HMAC verification instead of a database round
trip. The consequence, stated plainly: **demoting or suspending a user does not
take effect for up to 15 minutes** (the access-token TTL) on endpoints that
only check the token.

That is an accepted trade, bounded by the short TTL. Where it is unacceptable,
`requireFreshUser` loads the user and re-checks `role` and `status` against the
database. It is opt-in precisely because it costs a query per request; applying
it globally would discard the main benefit of stateless tokens.

Refresh is not affected: `POST /auth/refresh` loads the user and rejects a
non-active account, so a suspension takes hold within one access-token
lifetime at the latest. There is a test for this.

## 4. The authorization pipeline

```
Request
  │
  ├─ rateLimit            429 if over budget        (before any expensive work)
  ├─ validate             400 on malformed input    (controller can now trust input)
  ├─ authenticate         401 if no/invalid token   → sets req.user = { id, role }
  ├─ requireRole(...)     403 if role insufficient  (coarse, token-only check)
  │
  └─ controller → service
                   │
                   ├─ load the resource             404 if absent
                   ├─ OWNERSHIP CHECK               403 if not owner/moderator
                   └─ perform the action
```

**Why the ownership check lives in the service and not in middleware:** it
needs the resource. Middleware runs before anything is loaded, so a middleware
ownership check would have to load the document itself — and then the service
loads it again, doubling every query. Role checks are different: they need only
the token, so they belong in middleware where they can short-circuit early.

## 5. Resource ownership

| Action | Rule | Status |
|---|---|---|
| Delete a post | Author, moderator, or admin | **Implemented**, tested (403 for a stranger, 204 for a moderator) |
| Vote | Any authenticated user, except on their own content | **Implemented**, tested (409 `SELF_VOTE`) |
| Create a post into a college feed | The author's own college only — `collegeDomain` comes from the authenticated user, never the body | **Implemented**, tested |
| Edit a post/comment | Author only. Not moderators — editing someone's words under their name is worse than deleting them. | `[PLANNED]` — no edit endpoint exists |
| Delete a comment | Author, moderator, or admin | `[PLANNED]` |
| Edit a profile | Owner only | `[PLANNED]` — no profile endpoint exists |
| Suspend an account | Admin only | `[PLANNED]` — only settable directly in the database |

How the implemented check is written, and why it is one operation:

```js
// post.service.js — the ownership predicate is part of the query filter.
const filter = { _id: postId, status: "active" };
if (!isModerator) filter.authorId = viewer.id;
const deleted = await Post.findOneAndUpdate(filter, { $set: { status: "deleted" } });
```

Read-then-write (`load the post, compare, then update`) would be two round
trips **and** a race: two concurrent deletes both read `status: "active"` and
both run the side effects. Filter and update as one atomic operation means the
second caller matches nothing.

Two rules enforced in code rather than left implicit:

- **Ownership is compared against the stored document**, never against an id in
  the request body. `post.authorId === req.user.id` is safe;
  trusting a client-supplied `authorId` is the IDOR hole itself.
- **404 vs 403 on a resource you may not touch.** Returning 403 confirms the
  resource exists, which leaks information for a private resource. For
  CollegeGram's public posts that leak is harmless and 403 is clearer, so we
  use 403 — a deliberate choice, not an oversight. Note the ordering in
  `deletePost`: we only distinguish 403 from 404 *after* confirming the post
  exists, so the endpoint cannot be used to probe for valid post ids.

## 6. Edge cases worth knowing

| Case | Behaviour |
|---|---|
| Token valid, user deleted since | `/auth/me` → 404; refresh → 401. Token-only endpoints still accept it until expiry (the staleness window). |
| Token valid, user suspended | Same window. Refresh rejects immediately. |
| Expired access token | 401 `TOKEN_EXPIRED` — distinct from `TOKEN_INVALID` so the client knows to refresh rather than to log out. |
| Refresh token replayed after use | Whole session family revoked, 401 `SESSION_REVOKED`. See `auth.service.js`. |
| Two tabs refresh simultaneously | Both succeed, via the 10-second grace window. Tested. |
| Request with no `Authorization` on an `optionalAuth` route | Proceeds anonymously. |
| Invalid token on an `optionalAuth` route | Proceeds anonymously — the caller asked for public data. |
| Moderator acting on their own content | Allowed as owner; the role is irrelevant. |
| Privilege escalation via request body | Impossible: `role` is not in any schema, so it is stripped. Tested. |

## 7. What is NOT implemented

Named explicitly so none of it is mistakenly claimed:

- Edit endpoints for posts, comments and profiles (so the author-only edit rule
  above is a decision, not yet code)
- Comment deletion and moderation
- Dedicated admin endpoints: suspending an account is a direct database update
- Per-college or per-community scoping of moderator powers
- Email verification before an account becomes active
- Password reset (which would also need `logoutAll` on completion — the
  function exists and is tested; nothing calls it for that purpose yet)
- An audit log of privileged actions
