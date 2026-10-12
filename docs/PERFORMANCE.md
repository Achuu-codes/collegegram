# Feed query performance — measured, not estimated

Every number on this page came from `backend/scripts/benchmark.js`, which seeds
a throwaway database and reports MongoDB's own `explain("executionStats")`.
Re-run it yourself:

```bash
cd backend && node scripts/benchmark.js 50000
```

**Conditions.** 50,000 posts across 5 colleges (10,000 per college), MongoDB
8.3.4 on a local machine, warm cache, single mongod. These are laptop numbers:
the *ratios* and `docsExamined` are the meaningful part, not the milliseconds.

## The result

| # | Query | Index chosen | Returned | Keys examined | Docs examined | In-memory sort | Time |
|---|---|---|---|---|---|---|---|
| A | "new" feed, page 1 | `collegeDomain_1_status_1_createdAt_-1__id_-1` | 20 | 20 | 20 | no | 0 ms |
| B | "new" feed, page ~400, **cursor** | same | 20 | **20** | 20 | no | 0 ms |
| C | "new" feed, page ~400, **skip(8000)** | same | 20 | **8,020** | 20 | no | 8 ms |
| D | "top" feed, page 1 | `collegeDomain_1_status_1_score_-1__id_-1` | 20 | 20 | 20 | no | 0 ms |
| E | "new" feed, page 1, **compound index withheld** | `authorId_1` | 20 | 50,000 | **50,000** | **YES** | 24 ms |

## What each row proves

**A vs B — cursor pagination is depth-independent.** Page 400 examines exactly
as many index keys as page 1: twenty. The query is an index *seek* to the
cursor's position followed by a scan of twenty entries.

**B vs C — this is why `skip` was rejected.** To return the same twenty posts,
`skip(8000)` walks and discards 8,000 index keys first: 8,020 keys examined
against 20. The cost grows linearly with scroll depth, so the users who read
the most get the slowest responses. At page 4,000 it would be 80,020 keys.
(`skip` is also *incorrect* on a live feed — a post inserted between two
requests shifts every later row, so the reader sees a duplicate. That bug is
covered by a test, not a benchmark.)

**D — the second index exists so "top" is also a seek.** Without
`{collegeDomain, status, score, _id}`, sorting by score would be row E.

**E — what the compound index is actually buying.** Deny the planner that index
and the same twenty-row query examines **all 50,000 documents** and then sorts
them in memory. Two consequences beyond the 24 ms: memory use scales with
collection size, and MongoDB aborts a blocking sort once it exceeds 32 MB — so
this does not get gradually slower in production, it starts failing outright.

## Why the index fields are in that order

`{ collegeDomain: 1, status: 1, createdAt: -1, _id: -1 }` follows **ESR —
Equality, Sort, Range**:

1. **Equality** first (`collegeDomain`, `status`): narrows the index to one
   college's active posts.
2. **Sort** next (`createdAt`): the matching keys are already in the required
   order, so no sort stage is needed.
3. **Range/tie-breaker** last (`_id`): the cursor's `$lt` comparison.

Putting the sort key first (`{createdAt: -1, collegeDomain: 1}`) would force a
scan of every post ever written to find one college's — row E, essentially.

## What has NOT been measured

Stated so that nothing here is oversold:

- No concurrent load test. There is no claim about requests per second.
- No measurement of the Redis feed cache's hit rate under real traffic; its 30s
  TTL is a judgement call, not a tuned number.
- Single-node MongoDB. No replica-set, write-concern or network latency effects.
- Vote and comment write paths are not benchmarked; they are single-document
  operations on indexed keys and were not the suspected bottleneck.
