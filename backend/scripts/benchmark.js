/**
 * Measure the feed query. Every number in docs/PERFORMANCE.md comes from here.
 *
 * Run with:  node scripts/benchmark.js
 *
 * It seeds a throwaway database, then uses explain("executionStats") to report
 * what MongoDB actually did: which index was chosen, how many documents it
 * examined to return 20, and whether it had to sort in memory. `docsExamined`
 * is the number that matters — if it is much larger than `nReturned`, the
 * index is not doing its job, however fast the query happens to be on a laptop
 * with a warm cache.
 */
import mongoose from "mongoose";
import { Post } from "../src/modules/post/post.model.js";

const URI = "mongodb://127.0.0.1:27017/collegegram_bench";
const COLLEGES = ["mit.edu", "harvard.edu", "stanford.edu", "berkeley.edu", "yale.edu"];
const TOTAL = Number(process.argv[2] ?? 50_000);

const summarize = (plan, label) => {
  const stage = plan.executionStats.executionStages;
  const winning = plan.queryPlanner.winningPlan;
  const indexName = JSON.stringify(winning).match(/"indexName":"([^"]+)"/)?.[1] ?? "COLLSCAN";
  console.log(`\n${label}`);
  console.log(`  index chosen     : ${indexName}`);
  console.log(`  nReturned        : ${plan.executionStats.nReturned}`);
  console.log(`  docsExamined     : ${plan.executionStats.totalDocsExamined}`);
  console.log(`  keysExamined     : ${plan.executionStats.totalKeysExamined}`);
  console.log(`  executionTimeMs  : ${plan.executionStats.executionTimeMillis}`);
  console.log(`  in-memory SORT   : ${JSON.stringify(stage).includes('"stage":"SORT"') ? "YES" : "no"}`);
};

async function main() {
  await mongoose.connect(URI);
  await mongoose.connection.dropDatabase();
  await Post.syncIndexes();

  console.log(`seeding ${TOTAL} posts across ${COLLEGES.length} colleges...`);
  const authorId = new mongoose.Types.ObjectId();
  const batchSize = 5_000;
  const startedAt = Date.now();

  for (let offset = 0; offset < TOTAL; offset += batchSize) {
    await Post.insertMany(
      Array.from({ length: Math.min(batchSize, TOTAL - offset) }, (_, i) => ({
        authorId,
        collegeDomain: COLLEGES[(offset + i) % COLLEGES.length],
        title: `Seeded post ${offset + i}`,
        body: "x".repeat(200),
        score: Math.floor(Math.random() * 500),
        // Spread createdAt so the cursor has something to seek through.
        createdAt: new Date(Date.now() - (offset + i) * 1000),
      })),
      { ordered: false }
    );
  }
  console.log(`seeded in ${Date.now() - startedAt}ms`);

  const filter = { collegeDomain: "mit.edu", status: "active" };

  summarize(
    await Post.find(filter).sort({ createdAt: -1, _id: -1 }).limit(20).explain("executionStats"),
    'A. "new" feed, page 1 (keyset, no cursor)'
  );

  // A cursor positioned deep in the feed: ~8,000 posts in.
  const deep = await Post.find(filter).sort({ createdAt: -1, _id: -1 }).skip(8_000).limit(1).lean();
  summarize(
    await Post.find({
      ...filter,
      $or: [
        { createdAt: { $lt: deep[0].createdAt } },
        { createdAt: deep[0].createdAt, _id: { $lt: deep[0]._id } },
      ],
    })
      .sort({ createdAt: -1, _id: -1 })
      .limit(20)
      .explain("executionStats"),
    "B. same feed, page ~400 via CURSOR"
  );

  summarize(
    await Post.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(8_000)
      .limit(20)
      .explain("executionStats"),
    "C. same page via SKIP (the approach we rejected)"
  );

  summarize(
    await Post.find(filter).sort({ score: -1, _id: -1 }).limit(20).explain("executionStats"),
    'D. "top" feed, page 1'
  );

  // What the query would cost without the compound index: force the plan to
  // use only the single-field authorId index, i.e. no help for filter+sort.
  summarize(
    await Post.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(20)
      .hint({ authorId: 1 })
      .explain("executionStats"),
    "E. SAME QUERY with the compound index withheld (hint: authorId_1)"
  );

  console.log(`\ntotal posts: ${await Post.estimatedDocumentCount()}`);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
