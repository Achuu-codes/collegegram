# CollegeGram — 30-minute revision

Read top to bottom once. Timings are the budget, not a suggestion.

| | Section | Minutes |
|---|---|---|
| 1 | The pitch + the map | 4 |
| 2 | The 12 decisions you must defend | 9 |
| 3 | Standard questions, short answers | 10 |
| 4 | Traps, and what to volunteer | 4 |
| 5 | Live demo script | 3 |

**The one rule:** every answer is *"X, because Y, and the trade-off is Z."* An
answer with no trade-off sounds memorised. An interviewer drilling you is
looking for the boundary of your understanding — so show them where it is
deliberately, rather than letting them find it.

---

## 1. The pitch + the map (4 min)

### Say this (~40 seconds)

> CollegeGram is a college-scoped discussion API — Node, Express 5, MongoDB,
> Redis. Users register with a college email, and the feed is partitioned by
> their email domain. You post, vote and comment. The parts I'd actually want
> to talk about are the auth design — short access tokens plus rotating
> refresh tokens with reuse detection — the concurrency work on voting, which
> is done with unique indexes and atomic operators rather than locks, and the
> feed, which is cursor-paginated and index-backed. 68 integration tests
> against a real MongoDB and Redis, because most of what's interesting is
> database behaviour that a mock would fake.

### The request path — recite this in order

```
client
  → requestContext   req.id + child logger, times the request
  → helmet           security headers
  → cors             explicit origin allowlist (never "*" with credentials)
  → express.json     64kb cap
  → sanitize         rejects keys starting with "$" or __proto__
  → rateLimit        Redis fixed window, per endpoint
  → authenticate     verifies JWT → req.user     (401 here)
  → validate         Zod: params, query, body     (400 here)
  → controller       thin: no logic, no DB
  → service          business rules + Mongo/Redis (403/404/409 here)
  → notFoundHandler  nothing matched → 404
  → errorHandler     LAST. one JSON error shape, always
```

### The layout

```
backend/src/
  config/index.js        every env var parsed + validated at boot; exits on bad input
  lib/                   errors.js, logger.js, mongo.js, redis.js, pagination.js
  middleware/            requestContext, sanitize, validate, rateLimit, authenticate, errorHandler
  modules/
    auth/                routes → controller → service; token.service, password, session.model
    user/user.model.js
    post/                post.model, vote.model, post.service (feed, votes, comments)
    comment/comment.model.js
    health/              /health and /health/ready
  app.js                 builds the app, never listens  ← lets tests drive it in-process
  server.js              connects Mongo, then listens; graceful SIGTERM shutdown
```

**Why `app.js` and `server.js` are separate** — the single most likely "why is
this like that?" about the structure. Tests import `createApp()` and drive it
with supertest in-process: no port, no startup race, no stray listeners.

---

## 2. The 12 decisions you must defend (9 min)

**1. Why JWT and not a server session?**
Access tokens are verified with one HMAC — no database round trip on every
authenticated request, and nothing to share between instances when you scale
horizontally. The cost is that a JWT can't be revoked before it expires, which
is why access tokens live 15 minutes and the long-lived credential (the refresh
token) *is* stored server-side in the `sessions` collection and is revocable.
So: stateless where it's hot, stateful where it must be revocable.

**2. Where do the tokens live, and why?**
Access token: memory only, 15 min. Refresh token: `httpOnly`, `SameSite=Strict`,
`Path=/auth` cookie, 30 days. localStorage is readable by any script on the
page, so one XSS — ours or a dependency's — leaks it. The credential JS can
read dies in 15 minutes; the long-lived one JS cannot read at all.

**3. Refresh token rotation and reuse detection.**
Every refresh issues a new refresh token and atomically invalidates the old one
(`findOneAndUpdate` on the `jti`). If an *already-consumed* token is presented,
either a thief has it or the legitimate user does — we can't tell, so we revoke
the whole session **family** and force a fresh login. That's `revokedReason:
"reuse_detected"`.

**4. Then why a 10-second grace window?**
Because two browser tabs refreshing at the same instant look exactly like
theft. One wins the atomic swap; the loser would be logged out for being a
*correct* client. Within 10 seconds of rotation, the previous token is still
served (via `replacedJti`). Trade-off: a stolen token has a 10-second replay
window. Logging real users out constantly is the worse failure.

**5. bcrypt, cost 12 — and the 72-byte trap.**
bcrypt is deliberately slow and salts per-password, so identical passwords get
different hashes and offline brute force is expensive. Cost 12 ≈ 250ms here;
each +1 doubles it. bcrypt silently **truncates at 72 bytes**, so a 100-char
password would have its tail ignored — we reject over-72-*byte* passwords in
Zod instead. Bytes, not characters: 30 emoji is 120 bytes. (Tests cover both.)

**6. Why do wrong-password and unknown-account return the identical error?**
User enumeration. If they differed, an attacker harvests valid emails without
guessing a password. We also hash a dummy value when the user doesn't exist, so
the two paths take similar time and the *timing* doesn't leak it either.

**7. Voting: how do you prevent double votes without a lock?**
A unique compound index on `(userId, postId)`. Checking "has this user voted?"
in application code is a time-of-check/time-of-use race: two concurrent
requests both see no vote, both insert. Only the database has a serialization
point. One insert wins, the other gets E11000. The score is then updated with
`$inc`, which is atomic server-side so no increment is lost. A test fires 10
identical votes concurrently and asserts exactly one row and a score of 1.

**8. Why is the score delta computed from `returnDocument: "before"`?**
Flipping +1 → −1 is a delta of **2**, not 1 — the classic vote-counter bug. The
previous value must come from the same atomic operation that replaced it, not
from an earlier read; otherwise two concurrent votes both read the same old
value and apply the same delta twice.

**9. `score` and `commentCount` are denormalized — justify it, and the risk.**
Feeds are read vastly more than written. Counting votes per post on read would
be ~40 extra queries per 20-post page. So we pay `$inc` on write. The risk is
drift if the process dies between the two writes — which is why the
**authoritative write (the vote) happens first**: drift means a stale counter,
never a lost vote. `reconcileScore()` rebuilds the counter from the votes, and
a test proves it.

**10. Cursor pagination, not skip/limit.** *(Has real numbers — see §5.)*
`skip(8000)` makes Mongo walk and discard 8,000 index keys to return 20:
measured 8,020 keys examined versus 20 for the cursor, and it gets worse the
deeper you scroll. It's also *wrong* on a live feed — a new post shifts every
row down and the reader sees a duplicate. Keyset is an index seek: constant
cost, stable under inserts. The `_id` tie-breaker is mandatory, because sorting
by `score` alone is not a total order.

**11. What exactly is cached in Redis, and what happens when Redis dies?**
Only the first page of each `(college, sort)` feed, 30s TTL. Page 1 is where
traffic concentrates; deep pages have near-zero hit rate. **Redis is never a
source of truth** — `enableOfflineQueue: false` so commands fail fast instead
of queueing forever, and every cache failure is treated as a miss and falls
through to Mongo. A cache outage must never be an application outage. The rate
limiter is the one component that needs Redis; if it's down we log and allow
the request (fail-open), which is a conscious availability-over-strictness
choice.
Also: `myVote` is personalized **after** the cache read — caching per-user data
under a shared key is how you serve one user's data to another. There's a test.

**12. Index field order: `{collegeDomain, status, createdAt, _id}`.**
**ESR — Equality, Sort, Range.** Equality first narrows to one college's active
posts, then the sort key means no in-memory sort stage, then `_id` for the
cursor. Sort-key-first would scan every post ever written. Measured: with the
compound index the query examines 20 documents; without it, all 50,000 *and* a
blocking in-memory sort — which Mongo aborts past 32MB, so it fails rather than
degrading.

---

## 3. Standard questions, short answers (10 min)

### Node / JavaScript

**Is Node single-threaded?**
One thread runs your JavaScript; I/O is handled by libuv, which has a thread
pool (default 4) for file system, DNS and crypto work. So I/O is concurrent,
JS execution is not. CPU-bound work blocks everything — that's what
`worker_threads` or a separate service is for. bcrypt is relevant here: it's
CPU-heavy but the native addon runs on the pool, so it doesn't block the loop.

**Event loop order.**
Phases: timers → pending callbacks → poll → check (`setImmediate`) → close.
Between every phase it drains microtasks: `process.nextTick` first, then
promise callbacks. So `nextTick` beats `Promise.then` beats `setTimeout(…, 0)`.

**`async/await` vs callbacks vs promises.**
Same event loop; `await` is syntax over promises. The practical win is error
handling — one `try/catch` instead of an `err` argument per callback — plus no
callback nesting. Careless `await` in a loop serializes independent work;
`Promise.all` when the calls don't depend on each other.

**How are errors from an async route handled?**
Express 5 forwards a rejected promise from an async handler to the error
middleware automatically. **Express 4 did not** — it would hang the request, so
every handler needed `asyncHandler`/`try-catch`. That's why there's no wrapper
in my controllers, and it's a real, concrete Express 5 difference.

**`uncaughtException` — why exit instead of continuing?**
A stack unwound past every handler means invariants may be broken and memory
may hold half-written data. Logging and continuing is how corrupt data gets
written for hours before anyone notices. Log fatally, shut down gracefully,
let the supervisor restart.

**What is graceful shutdown and why does SIGTERM matter?**
On deploy the orchestrator sends SIGTERM, then SIGKILL after a grace period.
Node's default is to exit *immediately*, killing in-flight requests. We
`server.close()` (stop accepting new connections, let current ones finish),
close Mongo and Redis, exit 0 — with a forced-exit timer as the safety valve so
a hung request can't hang the deploy.

### Express / HTTP / API design

**What is middleware, and why does order matter?**
A function `(req, res, next)` in a chain; each either responds or calls
`next()`. Order is semantics: the body parser must precede validation,
`requestContext` must be first so everything downstream has `req.id`, and the
error handler must be **last** — Express selects it by its 4-argument arity and
only considers handlers registered *after* the one that threw.

**Status codes you'll be asked to justify.**
200 OK · 201 Created (POST that creates) · 204 No Content (logout, delete) ·
400 validation · **401 vs 403: 401 = "I don't know you, present credentials",
403 = "I know exactly who you are, still no"** · 404 not found · 409 conflict
(duplicate email, self-vote) · 413 payload too large · 429 rate limited (with
`Retry-After`) · 500 unexpected · 503 dependency down.

**Is your API RESTful?**
Mostly: resource URLs, HTTP verbs, stateless auth, meaningful statuses. One
deliberate deviation — `POST /posts/:id/vote` with `{value: 1|-1|0}` instead of
PUT/DELETE on a vote sub-resource. It's one idempotent endpoint for cast,
change and retract, which is simpler to rate-limit and test. I'd rather name
the deviation than pretend it's pure REST.

**Idempotency?**
Re-sending the same vote is a no-op — a delta of 0, no write to the post. Logout
is idempotent (204 twice). That matters because clients retry on timeout.

**CORS — what is it actually protecting?**
The browser's same-origin policy; it's enforced by the browser, not the server
— `curl` ignores it entirely, so CORS is not an access-control mechanism. Our
API serves `:5173` from `:5050`, so it needs an explicit origin allowlist.
`origin: true` (reflect any origin) with `credentials: true` is a serious hole:
any website could make authenticated requests with the user's cookies.
Browsers forbid `*` with credentials for the same reason; reflection is that
mistake in disguise.

**Validation — why Zod at the edge when Mongoose also validates?**
Different jobs. Zod rejects malformed input before it touches the DB and
**strips unknown keys**, which is what kills mass assignment: `{"role":
"admin"}` at signup never reaches the service because the schema doesn't
declare it. Mongoose validation is the last-resort invariant on the data
itself. There's a test asserting a client-supplied `role` is ignored.

### MongoDB

**Why MongoDB here — and would you defend SQL instead?**
A post with its denormalized counters is a natural document, there are no
multi-entity transactions in this project, and the read patterns are known and
narrow. But I'd be honest: votes are a textbook relational join table, and
Postgres would give me `SUM(value)` with real constraints and no counter drift.
I chose Mongo and then wrote the concurrency tests the choice demands.

**How do you know an index is being used?**
`explain("executionStats")`. The numbers that matter are `docsExamined`
vs `nReturned` — close is good — and whether there's a `SORT` stage, which
means it sorted in memory. Measured output is in `docs/PERFORMANCE.md`.

**What's a compound index, and when is one index not enough?**
Fields in a defined order; a query can use a **prefix** of it. One index
supports filter+sort+cursor for the "new" feed; "top" sorts by `score`, which
is a different sort key, so it needs its own index. Indexes cost write
throughput and storage — they're not free, so two feeds, two indexes, no more.

**Transactions?**
Supported on replica sets, and not used here. Every write in this system is a
single-document atomic operation (`$inc`, `findOneAndUpdate`, a unique-index
insert), which is atomic in MongoDB without a transaction. A transaction would
add round trips and a retry loop to buy consistency I don't need for a score.
If I added "transfer reputation between users", that's when I'd reach for one.

**NoSQL injection — is that a real thing?**
Yes. `findOne({email, password})` with a body of `{"$ne": null}` matches the
first user and logs you in as them. Two layers stop it: Zod's `z.string()`
rejects the object structurally, and the sanitize middleware rejects any key
starting with `$` or touching the prototype. There's a test that sends exactly
that payload.

**Soft delete — why?**
A hard delete orphans comments and votes and makes moderation unauditable.
Posts carry `status`, the feed filters on it, and `status` is in the index.

### Redis

**What is Redis for in this project?** Two things: the feed cache and the rate
limiter's counters. Both are allowed to be lost.

**Why is the rate limiter a Lua script?**
`INCR` then `EXPIRE` as two calls has a race: if the process dies between them
the key never expires and the client is blocked forever. Lua runs atomically on
the server, so the increment and the TTL are one operation. It's a fixed window
— the known weakness is that a client can burst across a window boundary;
sliding-window-log or a token bucket fixes that at the cost of more state.

**Cache invalidation strategy?**
TTL-first, with explicit invalidation only where staleness is noticeable: a new
post clears that college's cached pages immediately, because "I posted and
can't see it" is instantly visible. Vote scores are left to the 30s TTL —
invalidating per vote would make the cache useless on exactly the hot posts.
Bounded staleness, chosen on purpose. Correct for a feed; wrong for a bank
balance.

### Testing

**What kind of tests, and why integration over unit?**
68 tests through the real HTTP stack with supertest, against a real MongoDB and
Redis. The behaviour worth testing *is* database behaviour — a unique index
arbitrating a race, `$inc` not losing updates, TTL semantics. A mocked Mongo
would happily pass tests for race conditions the real one fails: confidently
wrong, which is worse than no test. Cost: both services must be running, and
the suite takes ~6s instead of ~0.5s.

**How do you test a race condition?**
Fire the requests concurrently with `Promise.all` and assert the invariant, not
the timing: two registrations for one email → statuses `[201, 409]` and exactly
one user row; ten identical votes → one vote row, score 1.

**How do you test something time-dependent without sleeping?**
Age the data, not the clock. The reuse-grace test sets `replacedAt` to epoch 0
rather than waiting 10 seconds — a test that sleeps is slow, and a test tuned
to a real timing window is flaky.

**Test isolation?**
`afterEach` deletes all documents and flushes `cg:*` Redis keys. It **deletes
documents rather than dropping collections**, because dropping also destroys
the indexes that several tests exist to prove. Files run sequentially — parallel
workers would share one test DB and delete rows out from under each other. And
there's a guard that refuses to run if `NODE_ENV !== "test"` or the URI doesn't
contain "test", so the suite can never wipe a real database.

### Security (the checklist they'll walk)

| Threat | Mitigation here |
|---|---|
| Password cracking | bcrypt cost 12, per-password salt, 72-byte guard |
| User enumeration | identical error + dummy hash on the unknown-user path |
| XSS stealing credentials | access token in memory; refresh cookie `httpOnly` |
| CSRF | `SameSite=Strict` on the refresh cookie, `Path=/auth`; Bearer header elsewhere |
| Token forgery (`alg: "none"`) | algorithms pinned to `["HS256"]` on every verify, plus issuer check — **test exists** |
| Refresh token theft | rotation + family revocation on reuse |
| Mass assignment / privilege escalation | Zod strips undeclared keys — **test exists** |
| NoSQL operator injection | `z.string()` + `$`-key rejection — **test exists** |
| IDOR (deleting someone else's post) | ownership is part of the query filter, server-side — **test exists** |
| Brute force | per-endpoint Redis rate limits, keyed by IP **and** account |
| Prototype pollution | `__proto__`/`constructor`/`prototype` keys rejected |
| Payload DoS | 64kb body cap, `limit` capped at 50, nesting depth capped at 12 |
| Stack traces / internals leaking | `isOperational` split: bugs log in full, return a generic 500 |
| Secrets in git | `.env` gitignored; `.env.example` committed with names only; boot fails on a missing secret |

---

## 4. Traps, and what to volunteer (4 min)

### Volunteer these before you're asked — it reads as judgement, not weakness

- **Access tokens can't be revoked for up to 15 minutes.** Suspend a user and
  their current token still works until it expires. Accepted, bounded, and
  documented; `requireFreshUser` exists for routes where that's unacceptable.
- **The rate limiter fails open.** Redis down means requests are allowed. For a
  college discussion app, availability beats strictness; for a payments API I'd
  fail closed.
- **Counters can drift** from the votes if a process dies mid-write. Repairable
  by design, with `reconcileScore()` and a test — but there's no scheduled job
  running it yet.
- **Fixed-window rate limiting allows a boundary burst.** Known; a sliding
  window is the fix.
- **Flat comments, no nesting.** A deliberate scope cut; `parentId` can be
  added without migrating existing rows.
- **No email verification**, so `collegeDomain` is claimed, not proven. That's
  the first thing I'd build next, and it's the honest hole in a
  "college-verified" product.

### When you don't know

Say: *"I haven't implemented that. My instinct is X, because Y — but I'd want
to measure before claiming it."* Then stop. Do **not** invent a number, a
benchmark, or a feature. One fabricated detail and everything else you said
becomes suspect.

### Questions designed to catch you out

- *"What happens when 1,000 people vote at the same second?"* → `$inc` is
  atomic server-side, so no update is lost; one Vote row per user is guaranteed
  by the unique index. The feed's cached score can be up to 30s stale, by
  choice. The write bottleneck would be contention on the single post document.
- *"Scale this to a million users."* → First: what's the bottleneck? Reads, so
  read replicas and cache the hot feed pages. Then the feed itself: fan-out is
  partitioned by college, so it shards naturally on `collegeDomain`. I'd
  measure before adding a queue or a search cluster — and I'd say plainly that
  this project has never been load-tested.
- *"Why not microservices / Kafka / GraphQL?"* → Nothing here justifies them.
  One deployable, one database, a known read pattern. Adding them would add
  operational surface and failure modes without solving a problem I have.
- *"Walk me through what happens on login."* → Zod validates → rate limiter has
  already counted per IP *and* per account → `findOne` by email **or** username
  (indexed, case-normalized) → bcrypt compare (dummy hash if no user, so timing
  matches) → status check (403 if suspended) → create a Session row with a new
  `familyId` → sign a 15-min access token and a 30-day refresh token → set the
  httpOnly cookie, return the access token in the body.
- *"Where's the single point of failure?"* → MongoDB. Redis is optional by
  design; Mongo is not. Single node today — a replica set is the fix, and
  `/health/ready` already reports `degraded` vs `unavailable` so a load
  balancer can act on it.

---

## 5. Live demo script (3 min)

Have this already running before the call.

```bash
# terminal 1
brew services start mongodb-community && brew services start redis
cd backend && npm run dev          # http://localhost:5050

# terminal 2 — the proof
npm test                           # 68 passed
node scripts/benchmark.js 50000    # the explain() numbers in §2.10 and §2.12
```

```bash
# terminal 3 — the API, by hand
curl -s localhost:5050/health/ready | jq

curl -s -X POST localhost:5050/auth/register -H 'content-type: application/json' \
  -d '{"email":"demo@mit.edu","username":"demo","displayName":"Demo","password":"correct-horse-battery-staple"}' \
  -c /tmp/cg.txt | jq            # cookie jar holds the refresh token

TOKEN=$(curl -s -X POST localhost:5050/auth/login -H 'content-type: application/json' \
  -d '{"identifier":"demo@mit.edu","password":"correct-horse-battery-staple"}' | jq -r .data.accessToken)

curl -s -X POST localhost:5050/posts -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"title":"Best coffee on campus","body":"Asking for a friend."}' | jq

curl -s "localhost:5050/posts?sort=new" -H "Authorization: Bearer $TOKEN" | jq '.data.items'

# the two demos worth showing
curl -s -X POST localhost:5050/auth/login -H 'content-type: application/json' \
  -d '{"identifier":{"$ne":null},"password":{"$ne":null}}' | jq   # → 400, injection blocked
for i in 1 2 3 4 5 6; do curl -s -o /dev/null -w "%{http_code} " -X POST \
  localhost:5050/auth/login -H 'content-type: application/json' \
  -d '{"identifier":"demo@mit.edu","password":"wrong"}'; done     # → 401×5 then 429
```

Frontend, if asked: `cd frontend && npm run dev` → http://localhost:5173.

### Numbers to have on the tip of your tongue

| Thing | Value |
|---|---|
| Tests | **68**, ~6s, real Mongo + Redis |
| Access token TTL | 15 min · refresh 30 days · reuse grace 10s |
| bcrypt cost | 12 (≈250ms) · max password 72 **bytes** |
| Rate limits | register 3/h · login 5/15min (IP **and** account) · post 10/h · vote 60/min · feed 120/min |
| Feed cache | page 1 only, 30s TTL |
| Feed page | 20 default, 50 max |
| Cursor vs skip at page ~400 | **20 keys examined vs 8,020** |
| Without the compound index | 50,000 docs examined + in-memory SORT (32MB abort limit) |
| Body limit | 64kb · nesting depth 12 |
| Mongo pool | max 20, min 2 per process |

### Last 30 seconds before you walk in

Three sentences that carry the whole interview:

1. **"Unique indexes and atomic operators, not locks."**
2. **"Redis is an optimization, never a source of truth."**
3. **"The counter is a cache; the vote is the truth — so drift is always repairable."**
