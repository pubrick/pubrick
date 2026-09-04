import { runMigrations } from "@pubrick/db";
import { PgBoss } from "pg-boss";

/**
 * Runs once, in the main vitest process, before any test file starts. See the matching
 * comment in apps/api/vitest.global-setup.ts: apps/api and apps/worker's e2e specs
 * target the SAME real TEST_DATABASE_URL, and turbo runs both packages' `test` tasks
 * concurrently — every process calling runMigrations() adds another bootstrap racing
 * the others for CPU and another (brief) queue on the migration advisory lock. One
 * barrier per package keeps that to two calls total instead of one per e2e file.
 */
export async function setup(): Promise<void> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  await runMigrations(url);
  await installQueueSchema(url);
}

/**
 * The SECOND half of "the database this tier talks to", and the reason it is a barrier
 * rather than a side effect of whichever spec happens to run first.
 *
 * `packages/db`'s migrations own `public`; nothing in them creates `pgboss`. That schema
 * comes into existence only when some pg-boss instance calls `start()`. But the sweeps
 * read it directly — `PublishRepository.sweepAbandoned` and `GenerateRepository.
 * sweepAbandoned` both ask "is any non-terminal job still going to finish this row?",
 * which is a `pgboss.job` subquery — so `publish.repository.spec.ts` queries a schema it
 * never creates. Before this call its existence was inherited from another FILE
 * (`generate.e2e.spec.ts` / `publish.e2e.spec.ts` start a real boss) or another PACKAGE
 * (every apps/api e2e boots a Nest app, whose QueueService starts one).
 *
 * That inheritance is exactly as reliable as the scheduling underneath it, which is to
 * say not at all — and it failed only in CI, because two local conditions hid it:
 *
 *  - a development database is long-lived, so `pgboss` is still there from a run weeks
 *    ago; CI's Postgres service container is empty every time;
 *  - vitest orders files by their last recorded duration, cached in
 *    `node_modules/.vite/vitest/**\/results.json`, which puts the two slow
 *    boss-starting e2e files first; a fresh checkout has no cache and falls back to
 *    ordering by file SIZE, which puts `publish.repository.spec.ts` (63K, and no boss of
 *    its own) ahead of every installer.
 *
 * So on CI the worker tier failed whenever turbo happened to schedule `@pubrick/worker#test`
 * before `@pubrick/api#test`, and passed when it did not: an undeclared dependency read as
 * a coin flip. Measured — 2 of the last 4 `main` runs failed, both on
 * `publish.repository.spec.ts`'s deadlock test, whose `sweepAbandoned()` rejected with
 * `relation "pgboss.job" does not exist` instead of parking on the row lock the test then
 * waited 5s for. Locally: 6/6 failures against an empty database with the sequencer cache
 * removed, 6/6 passes with this barrier in place.
 *
 * `start()` rather than `getConstructionPlans()`: it is idempotent, it takes pg-boss's own
 * advisory lock so the api tier installing concurrently is safe, and it MIGRATES a schema
 * an older pg-boss left behind — none of which hand-run DDL would do. Supervision and cron
 * stay off because this is an installation, not a running instance.
 */
async function installQueueSchema(connectionString: string): Promise<void> {
  const boss = new PgBoss({ connectionString, supervise: false, schedule: false, max: 2 });
  boss.on("error", (err: Error) => console.error("pg-boss error (worker global setup)", err));
  try {
    await boss.start();
  } finally {
    await boss.stop({ graceful: false, timeout: 5_000 });
  }
}
