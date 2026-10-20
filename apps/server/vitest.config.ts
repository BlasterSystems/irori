import { defineConfig } from "vitest/config";

/**
 * The db-gated suites share ONE disposable Postgres (IRORI_TEST_DATABASE_URL)
 * and some services mutate globally across it (e.g. jobs.reapOffline fails
 * every active job whose node is offline — a parallel file's live batch would
 * be reaped mid-test). Serial files keep those invariants deterministic; the
 * suite is import-bound, not compute-bound.
 */
export default defineConfig({
  test: {
    fileParallelism: false,
  },
});
