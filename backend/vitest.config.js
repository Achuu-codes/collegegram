import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    setupFiles: ["./tests/setup.js"],

    /**
     * Test FILES run sequentially, not in parallel.
     *
     * Vitest's default is a worker per file, which is faster — but every worker
     * would share the one `collegegram_test` database, and the afterEach clean
     * up in setup.js would delete documents out from under a test running in
     * another worker. The failures that produces are intermittent and
     * maddening to debug.
     *
     * The alternatives are a database per worker, or mongodb-memory-server.
     * Both are reasonable; both add moving parts. These suites run in a few
     * seconds, so buying determinism with sequential execution is the right
     * trade at this size. Revisit if the suite grows slow enough to matter.
     */
    fileParallelism: false,

    // Index creation and the bcrypt work factor make the first test slower
    // than a pure unit test; allow for it rather than seeing flaky timeouts.
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
