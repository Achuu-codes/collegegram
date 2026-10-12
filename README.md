# CollegeGram

A college-scoped discussion API. Register with a college email, and your feed is
the posts from your own college: post, vote, comment. Node + Express 5 +
MongoDB + Redis, with a small React client.

The interesting parts are the auth design, the concurrency handling on voting,
and the feed's pagination — all three are documented below with the reasoning,
not just the result.

```
68 integration tests, against a real MongoDB and a real Redis.
```

## Run it

Requires Node ≥ 20, MongoDB and Redis running locally.

```bash
brew services start mongodb-community
brew services start redis

cd backend
npm install
cp .env.example .env     # then generate the two JWT secrets — the file says how
npm run dev              # http://localhost:5050

cd ../frontend
npm install
npm run dev              # http://localhost:5173
```

```bash
cd backend
npm test                          # 68 tests
node scripts/benchmark.js 50000   # the explain() numbers in docs/PERFORMANCE.md
```

The process **refuses to start** if a required environment variable is missing
or malformed, and prints which one. That is deliberate: a server that cannot
possibly work should not accept traffic.

## Demo

`backend/scripts/demo.sh` walks the whole API with `curl` — the happy path
first, then the refusals. Server running, then:

```bash
cd backend && ./scripts/demo.sh
```

Real output, trimmed only of blank lines:

```console
▸ Readiness — reports each dependency, not just a 200
{"data":{"status":"ok","checks":{"mongo":"up","redis":"up"}}}

▸ Register — the college comes from the email domain
{"username":"alice14865","collegeDomain":"mit.edu","role":"user","reputation":0}

▸ The refresh cookie: httpOnly, SameSite=Strict, scoped to /auth
Set-Cookie: cg_refresh=<redacted>; Max-Age=2592000; Path=/auth; HttpOnly; SameSite=Strict

▸ Post — the college is taken from the author, NOT from the body below
{"title":"Best coffee on campus","collegeDomain":"mit.edu","score":0,"commentCount":0}

▸ A second user votes — one vote per user, enforced by a unique index
  upvote        → {"score":1,"myVote":1}
  same again    → {"score":1,"myVote":1}   # idempotent: not counted twice
  flip to down  → {"score":-1,"myVote":-1}  # a delta of 2, not 1
  retract       → {"score":0,"myVote":0}
  upvote again  → {"score":1,"myVote":1}

▸ Ten concurrent identical votes — exactly one is counted
{"score":1,"myVote":1}

▸ Comment
{"body":"Second floor of the library, no question.","author":"bob14865"}

▸ Feed — myVote is per viewer, applied after the shared cache read
{"title":"Best coffee on campus","score":1,"commentCount":1,"myVote":1,"author":"alice14865"}
{"title":"Best coffee on campus","score":1,"myVote":0}

▸ Now the refusals. NoSQL operator injection:
{"code":"VALIDATION_FAILED","message":"Request contains a disallowed key"}

▸ Privilege escalation at signup — undeclared keys are stripped
{"username":"mallory14865","role":"user","reputation":0}

▸ Deleting someone else's post (IDOR) — authenticated, still refused
{"code":"FORBIDDEN","message":"You can only delete your own posts"}

▸ Voting on your own post
{"code":"SELF_VOTE","message":"You cannot vote on your own post"}

▸ Brute force — 5 login attempts per 15 min, per IP and per account
  401 401 401 401 429 429

▸ An unknown route still answers in the one error shape, with a request id
{"code":"ROUTE_NOT_FOUND","message":"Cannot GET /nope","requestId":"96e9f72f-f005-477a-b764-8551ee826e1f"}
```

Nine lines in, that transcript has already shown the four things worth noticing:
the college is derived from the authenticated author and not from the body, a
repeated vote is idempotent while a flipped one moves the score by two, the
same cached feed page carries a different `myVote` per viewer, and every
failure comes back in one shape with a machine-readable `code`.

The script clears its own rate-limit counters on start-up (registration is
capped at 3/hour/IP) so it can be run repeatedly; the limiter is then
demonstrated for real at the end.

For the UI: `cd frontend && npm run dev` → <http://localhost:5173> — register,
post, vote and comment against the same API.

## API

Every response is `{ "data": ... }` or `{ "error": { code, message, details?, requestId } }`.
`code` is a stable string (`EMAIL_TAKEN`, `SELF_VOTE`, `RATE_LIMITED`) so clients
can branch on it without parsing prose.

| Method | Path | Auth | Notes |
|---|---|---|---|
| `GET` | `/health` | — | liveness |
| `GET` | `/health/ready` | — | pings Mongo and Redis; `ok` / `degraded` / `unavailable` |
| `POST` | `/auth/register` | — | 3/hour/IP. Sets the refresh cookie |
| `POST` | `/auth/login` | — | 5/15min, keyed by IP **and** account |
| `POST` | `/auth/refresh` | cookie | rotates the refresh token |
| `POST` | `/auth/logout` | cookie | idempotent, 204 |
| `POST` | `/auth/logout-all` | Bearer | revokes every session |
| `GET` | `/auth/me` | Bearer | |
| `POST` | `/posts` | Bearer | 10/hour. College comes from the author |
| `GET` | `/posts` | optional | `?sort=new\|top&limit=20&cursor=…&college=…` |
| `GET` | `/posts/:id` | optional | |
| `DELETE` | `/posts/:id` | Bearer | author, moderator or admin |
| `POST` | `/posts/:id/vote` | Bearer | `{value: 1 \| -1 \| 0}`; 0 retracts |
| `POST` | `/posts/:id/comments` | Bearer | 30/hour |
| `GET` | `/posts/:id/comments` | optional | cursor paginated |

A signed-in viewer gets `myVote` on each post; an anonymous one does not.

## How it is put together

```
backend/src/
  config/index.js     every env var parsed and validated once, at boot
  lib/                errors · logger · mongo · redis · pagination
  middleware/          requestContext · sanitize · validate · rateLimit
                       authenticate · errorHandler
  modules/            auth · user · post · comment · health
                      (each: routes → controller → service → model)
  app.js              builds the app and never calls listen()
  server.js           connects Mongo first, then listens; graceful shutdown
```

`app.js` and `server.js` are separate so the test suite can import the
fully-wired app and drive it in-process with supertest — no port, no startup
race. Controllers are thin: they read an already-validated request, call one
service function, and shape the response. Business logic and database access
live in services.

Middleware order is semantic, not cosmetic, and is documented in
[`app.js`](backend/src/app.js) and in each route file.

## The decisions worth defending

**Auth — stateless where it is hot, stateful where it must be revocable.**
A 15-minute access token is verified with one HMAC: no database round trip per
request. The 30-day refresh token is stored server-side so it *can* be revoked,
and lives in an `httpOnly`, `SameSite=Strict`, `/auth`-scoped cookie — so the
credential JavaScript can read expires in minutes, and the long-lived one is
invisible to JavaScript entirely. Each refresh rotates the token and
invalidates its predecessor atomically; replaying a consumed token revokes the
whole session **family**, because a thief and a victim are indistinguishable. A
10-second grace window keeps two tabs refreshing at once from looking like
theft. See [`auth.service.js`](backend/src/modules/auth/auth.service.js) and
[`docs/AUTHORIZATION.md`](docs/AUTHORIZATION.md).

**Voting — unique indexes and atomic operators, not locks.**
"One vote per user per post" cannot be enforced in application code:
`if (!await Vote.findOne(…)) create(…)` is a time-of-check/time-of-use race.
A unique index on `(userId, postId)` gives the database the final say, and
`$inc` on the post's score is atomic server-side, so no increment is lost. The
vote delta is read from the same atomic operation that replaced it
(`returnDocument: "before"`), which is what makes flipping +1 → −1 a delta of 2
rather than 1. A test fires ten identical votes concurrently and asserts one
row and a score of one.

**Counters are a cache; votes are the truth.**
`score` and `commentCount` are denormalized onto the post so a feed page is one
index hit instead of forty count queries. The authoritative write happens
first, so a crash between the two writes means a *stale counter*, never a lost
vote — and `reconcileScore()` rebuilds it from the votes. There is a test for
that too.

**Feeds — cursor pagination, measured.**
`skip(8000)` examines 8,020 index keys to return 20 rows; the keyset cursor
examines 20, at any depth. It is also *correct* under concurrent inserts, which
`skip` is not. Withhold the compound index and the same query examines all
50,000 documents and sorts them in memory. Real `explain()` output:
[`docs/PERFORMANCE.md`](docs/PERFORMANCE.md).

**Redis is an optimization, never a source of truth.**
Only page 1 of each feed is cached, for 30 seconds. Commands fail fast
(`enableOfflineQueue: false`) rather than queueing forever, and every cache
failure is treated as a miss that falls through to MongoDB. A cache outage must
not become an application outage. `myVote` is applied *after* the cache read,
so a shared cached page never carries one user's data to another.

**Validation at the edge, in Zod.**
Unknown keys are stripped before the service sees them, which is what kills
mass assignment — `{"role": "admin"}` at signup produces an ordinary user, and
a test proves it. `z.string()` also rejects `{"$ne": null}` structurally, and a
sanitize middleware rejects any `$`-prefixed or prototype-touching key as a
second layer.

**Tests go through the real stack.**
Supertest drives the full middleware chain against a real MongoDB and Redis,
because the behaviour worth testing *is* database behaviour: a unique index
arbitrating a race, `$inc` not losing updates, TTL semantics. A mocked Mongo
would pass tests for race conditions the real one fails. Races are tested with
`Promise.all` and asserted as invariants; time-dependent behaviour is tested by
ageing the data, never by sleeping.

## Known limitations

Stated here rather than discovered later:

- **No email verification**, so `collegeDomain` is claimed, not proven. This is
  the first thing to build next.
- **Access tokens cannot be revoked** for up to 15 minutes; suspending a user
  takes effect immediately on refresh, and on request only where
  `requireFreshUser` is applied.
- **The rate limiter fails open.** If Redis is down, requests are allowed. For
  this application availability beats strictness; for a payments API it would
  not.
- **Fixed-window rate limiting** permits a burst across a window boundary.
- **Counter drift is repairable but not repaired automatically** — there is no
  scheduled reconciliation job.
- **Comments are flat.** A deliberate scope cut; `parentId` can be added
  without migrating existing rows.
- **No load test.** There is no claim anywhere in this repo about requests per
  second. `docs/PERFORMANCE.md` is query-level `explain()` output, measured on
  a laptop, and says so.

## Docs

| | |
|---|---|
| [`docs/INTERVIEW_PREP.md`](docs/INTERVIEW_PREP.md) | the whole system in 30 minutes, with the standard questions |
| [`docs/AUTHORIZATION.md`](docs/AUTHORIZATION.md) | 401 vs 403, roles, ownership, the staleness window |
| [`docs/PERFORMANCE.md`](docs/PERFORMANCE.md) | measured `explain()` output for the feed queries |
| [`PROJECT_AUDIT.md`](PROJECT_AUDIT.md) | what the repo contained at the start, and the plan |
