import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

/**
 * `closeApi` (shutdown.ts) is the fix for the api never releasing its
 * connection pool on `docker compose up -d --build`'s SIGTERM. A spy that
 * merely checks `pool.end` was called would pass for a version that calls
 * `pool.end()` and immediately moves on without it actually finishing — the
 * exact shape of defect this project keeps re-finding (see
 * feedback_test_the_guard_call_sites and feedback_tests_that_cannot_catch_the_bug
 * in project memory). So this proves the two outcomes that matter instead:
 *
 *  1. A query already in flight when shutdown starts is allowed to FINISH —
 *     not aborted — and `closeApi` does not resolve until it has.
 *  2. The pool is genuinely closed afterwards: a new query against it fails.
 */
// The default 5s test timeout is tight once you add the ~1s deliberate sleep on
// top of a full Nest app bootstrap (AuthModule included) — vitest.global-setup.ts
// documents that same bootstrap cost spiking well past 5s under concurrent load
// (multiple e2e files/suites hitting one database at once, e.g. a local
// `--concurrency` > 1 run). This gives real headroom without hiding a genuine hang.
const TEST_TIMEOUT_MS = 20_000;

describe.skipIf(!url)("closeApi", () => {
  let app: INestApplication | undefined;

  afterEach(async () => {
    // Best-effort only: the passing path below closes `app` itself as part
    // of the behaviour under test. This just stops a failed assertion from
    // leaking an open app (and pool) into the next spec file's run.
    await app?.close().catch(() => {});
  });

  it(
    "drains an in-flight query before resolving, then refuses new ones",
    async () => {
      process.env.DATABASE_URL = url as string;
      process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
      process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
      // Migrations run once for the whole suite in vitest.global-setup.ts.
      const { AppModule } = await import("./app.module");
      const { pool } = await import("./db");
      const { closeApi } = await import("./shutdown");

      const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
      app = moduleRef.createNestApplication({ bodyParser: false });
      await app.init();

      let slowQueryResolvedAt = 0;
      // A full second of server-side sleep on its own connection: long enough
      // that shutdown, started shortly after, is guaranteed to still find it
      // checked out rather than already returned to the pool.
      const slowQuery = pool.query("select pg_sleep(1)").then(() => {
        slowQueryResolvedAt = Date.now();
      });

      // Let the query actually acquire a client before racing shutdown against
      // it — otherwise both could start from the pool's idle state and the
      // ordering asserted below would prove nothing.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const shutdownStartedAt = Date.now();

      await closeApi(app, pool);
      const shutdownFinishedAt = Date.now();
      app = undefined; // closeApi already closed it; afterEach must not double-close

      // Must not reject: if the pool had cut the connection instead of
      // draining it, `pg_sleep`'s query would fail rather than resolve.
      await slowQuery;

      // It was genuinely still running when shutdown began...
      expect(slowQueryResolvedAt).toBeGreaterThan(shutdownStartedAt);
      // ...and closeApi did not return until after it finished. A version that
      // calls `pool.end()` without awaiting it — or skips it and relies only on
      // Nest's onModuleDestroy — would let closeApi race ahead of the query
      // instead of waiting on it.
      expect(shutdownFinishedAt).toBeGreaterThanOrEqual(slowQueryResolvedAt);

      // The pool is actually closed, not merely "some hook ran": a fresh query
      // against it must fail.
      await expect(pool.query("select 1")).rejects.toThrow();
    },
    TEST_TIMEOUT_MS,
  );
});
