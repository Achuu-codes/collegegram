/**
 * Test harness.
 *
 * ISOLATION STRATEGY
 *   Tests run against a REAL MongoDB and a REAL Redis, in a database named
 *   `collegegram_test` (see MONGODB_URI_TEST). That is a deliberate choice
 *   over mocking the data layer: the behaviour most worth testing here is
 *   precisely the behaviour of the database — unique indexes rejecting a
 *   concurrent duplicate, findOneAndUpdate being atomic, TTL semantics. A
 *   mocked Mongo would happily "pass" tests for race conditions that the real
 *   one would fail, which makes the suite worse than useless: confidently
 *   wrong.
 *
 *   The cost is that you need both services running locally, and the tests are
 *   slower than pure unit tests. Worth it for this project's subject matter.
 *
 * CLEAN SLATE PER TEST
 *   afterEach deletes all documents and flushes the rate-limiter keys, so no
 *   test can depend on another's leftovers or on execution order. We delete
 *   documents rather than dropping collections because dropping also destroys
 *   the INDEXES, and several tests exist specifically to prove that a unique
 *   index is doing its job.
 */
import { beforeAll, afterEach, afterAll } from "vitest";
import mongoose from "mongoose";
import { connectMongo, disconnectMongo } from "../src/lib/mongo.js";
import { connectRedis, disconnectRedis, getRedis, isRedisHealthy } from "../src/lib/redis.js";
import config from "../src/config/index.js";

// A guard against catastrophe: if NODE_ENV were not "test", config would hand
// us the development URI and afterEach would wipe real data.
if (!config.isTest) {
  throw new Error("Tests must run with NODE_ENV=test (use `npm test`)");
}
if (!/test/.test(config.mongo.uri)) {
  throw new Error(`Refusing to run: test database URI does not contain "test" (${config.mongo.uri})`);
}

beforeAll(async () => {
  await connectMongo();
  await connectRedis();

  /**
   * Build indexes before the first test.
   *
   * Mongoose creates indexes lazily and in the background, so without this the
   * first duplicate-key test can race the index build and fail intermittently
   * — the insert succeeds because the unique index does not exist yet.
   * syncIndexes also DROPS indexes that are no longer declared in a schema,
   * which keeps the test database honest as the models evolve.
   */
  await mongoose.syncIndexes();
});

afterEach(async () => {
  const collections = Object.values(mongoose.connection.collections);
  await Promise.all(collections.map((c) => c.deleteMany({})));

  // Rate-limit counters would otherwise leak across tests: three registrations
  // in one test would exhaust the per-hour budget for every test after it.
  if (isRedisHealthy()) {
    const keys = await getRedis().keys("cg:*");
    if (keys.length) await getRedis().del(...keys);
  }
});

afterAll(async () => {
  await disconnectMongo();
  await disconnectRedis();
});
