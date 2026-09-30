import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    testTimeout: 30_000,
    // These files share a real Postgres and independently acquire the migration
    // advisory lock. Unbounded file workers exhausted four 10s setup hooks in
    // the integrated gate; sequential files passed all 128 tests with the same
    // hook limits. Bound resource contention instead of increasing timeouts.
    fileParallelism: false,
  },
});
