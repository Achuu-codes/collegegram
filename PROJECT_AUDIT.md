# Project audit — the starting point, and what was decided

Audited 2026-10-03 (full read of every non-`node_modules` file). Condensed
2026-10-13, once the build was done. The long-form version is in git history.

## 1. What this repo contained before the build

**No application.** The brief described a working platform with auth, feeds,
voting, comments, Redis and MongoDB. What existed was:

- `backend/server.js` — 18 lines: one route, `GET /` → `"API Running"`.
- `frontend/src/App.jsx` — the unmodified Vite starter page.
- `frontend/app.jsx` — an orphaned second component that nothing imported.
- One commit: *"Initial commit: project setup"*.

No models, routes, controllers, services, middleware, auth, Redis, tests or
docs. The word "user" did not appear in the backend.

That was a scoping correction, not a criticism: it changed the work from
"refactor an existing system" to "build one", and it means every line here was
written deliberately and can be explained. There is no legacy code to pretend
to understand.

## 2. Problems in the original 18 lines

Each is fixed now, and each is worth being able to explain:

| Observation | Why it mattered |
|---|---|
| DB connect failure was `console.log`'d and the process kept listening | The server would serve traffic with no database, returning 500s forever. Now: fail fast on boot (`lib/mongo.js`) |
| Port 5000 hardcoded | macOS binds 5000 to AirPlay Receiver — a classic "server won't start". Now 5050, from config |
| `cors` was a dependency but never used | The browser at `:5173` could not call `:5050` at all. Now an explicit origin allowlist |
| No error handler, 404 handler, request logging or graceful shutdown | All built in Phase 2 |
| No `/health` endpoint | Now `/health` and `/health/ready` |
| CommonJS backend, ESM frontend | Resolved: the backend is ESM (`"type": "module"`) |
| `axios` was a backend dependency, used only by the frontend's orphan file | Both removed; the client uses `fetch` |

## 3. Security findings from the audit

| Severity | Finding | Status |
|---|---|---|
| **High** | `backend/.env` held a live MongoDB Atlas connection string with an embedded username and password | Never committed (verified with `git ls-files`), so no repo leak. **Action still open: rotate that password in Atlas** — Database Access → edit the `shreyas` user → Edit Password → Autogenerate. It has sat in plaintext on disk, so rotation is cheap insurance |
| Medium | No CORS configuration | Fixed: explicit allowlist from config, never `*` with credentials |
| Medium | `mongoose.connect` failure did not stop the process | Fixed: fail fast |
| Low | No explicit request size limit | Fixed: 64kb, set consciously |
| Low | No helmet, rate limiting or input validation | All three now in place |

`.env` was correctly gitignored from the start, and `.env.example` is committed
with variable names and no values.

## 4. Decisions taken, and deliberately not taken

**Not built, on purpose:** microservices, Kafka, Kubernetes, Elasticsearch,
GraphQL, gRPC, a message queue, distributed locks, a permission/capability
engine, or a generic `BaseRepository<T>`. Nothing in this project justifies any
of them, and each would be a surface where the bottom of my knowledge is found
quickly. MongoDB's unique indexes and atomic update operators cover every
concurrency case here, which is a better answer than Redlock.

**Built instead:** one deployable, one database, one optional cache, a thin
vertical slice through every layer (config → logging → errors → model →
service → controller → route → test), replicated across auth, posts, votes and
comments.

**Development runs against local MongoDB**, not Atlas: tests can drop and
recreate databases freely, and `explain()` runs against realistic seeded data
without burning a shared cluster. Atlas is for deployment only.

**No invented numbers.** Every figure in `docs/PERFORMANCE.md` comes from
`backend/scripts/benchmark.js`, which anyone can re-run. Nothing in this repo
claims a requests-per-second figure, because no load test has been run.

## 5. What was built after this audit

`README.md` has the architecture and the API. In short: config validation,
structured logging, an error taxonomy, request context, sanitization, Zod
validation, Redis rate limiting, JWT auth with rotating refresh tokens and
reuse detection, users, posts, votes, comments, a cursor-paginated and
index-backed feed with a 30-second Redis cache, health and readiness probes,
graceful shutdown, 68 integration tests against real MongoDB and Redis, and a
small React client.

Still not built, and listed in README under *Known limitations*: email
verification, edit endpoints, comment moderation, admin endpoints, a scheduled
counter-reconciliation job, and any load testing.
