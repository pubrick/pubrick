import { ConflictException } from "@nestjs/common";
import {
  GENERATE_QUEUE_OPTIONS,
  GENERATE_WORK_OPTIONS,
  PUBLISH_QUEUE_OPTIONS,
} from "@pubrick/shared";
import type { QueueOptions, WorkOptions } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

/**
 * Compile-time proof of WHERE each option object is allowed to live, checked by
 * `pnpm typecheck` (which includes this file) rather than by a runtime
 * assertion that could only ever restate the literals.
 *
 * The `@ts-expect-error` is the load-bearing one: `groupConcurrency` is
 * declared on pg-boss's `WorkConcurrencyOptions`, part of `WorkOptions`, and is
 * absent from `QueueOptions`. Putting it in `GENERATE_QUEUE_OPTIONS` would NOT
 * fail at the `createQueue` call site — the spread `{ ...OPTIONS }` defeats the
 * excess-property check — it would simply be dropped, and nothing would cap
 * per-org concurrency. Here it fails loudly, and if a future pg-boss ever did
 * add the field to `QueueOptions`, TypeScript reports the now-unused
 * `@ts-expect-error` instead of leaving a stale comment behind.
 */
const _publishIsQueueOptions: QueueOptions = PUBLISH_QUEUE_OPTIONS;
const _generateIsQueueOptions: QueueOptions = GENERATE_QUEUE_OPTIONS;
const _generateIsWorkOptions: WorkOptions = GENERATE_WORK_OPTIONS;
// @ts-expect-error groupConcurrency is a work() option, never a QueueOptions field
const _groupConcurrencyIsNotAQueueOption: QueueOptions = { groupConcurrency: 1 };
void [
  _publishIsQueueOptions,
  _generateIsQueueOptions,
  _generateIsWorkOptions,
  _groupConcurrencyIsNotAQueueOption,
];

// Type-only: avoids importing "./queue.service" (which imports "../env", validated
// eagerly at module load) before beforeAll() below has set the env vars it needs.
type QueueServiceCtor = typeof import("./queue.service").QueueService;
type QueueServiceInstance = InstanceType<QueueServiceCtor>;

// Not an HTTP e2e spec: exercises QueueService's enqueue methods directly
// against a real pg-boss/Postgres instance, so the send()->null->throw branch is
// proven deterministically (two sequential awaits, same id) rather than by racing
// two concurrent HTTP requests and hoping the interleaving lands the same way twice.
describe.skipIf(!url)("QueueService", () => {
  let service: QueueServiceInstance;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const { QueueService } = await import("./queue.service");
    service = new QueueService();
    await service.onModuleInit();
  });

  afterAll(async () => {
    await service.onModuleDestroy();
  });

  it("creates the publish queue with the shared contract's options, heartbeat included", async () => {
    const { PUBLISH_DLQ, PUBLISH_QUEUE, PUBLISH_QUEUE_OPTIONS } = await import("@pubrick/shared");
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const rows = await db.execute(
      `SELECT expire_seconds, heartbeat_seconds, retry_limit, retry_delay, dead_letter
         FROM pgboss.queue WHERE name = '${PUBLISH_QUEUE}'`,
    );
    await pool.end();

    // Asserted against the real pgboss.queue row, not against the constants
    // being passed: createQueue is an ON CONFLICT DO NOTHING insert, so the
    // options only actually land because onModuleInit follows it with
    // updateQueue. Without heartbeat_seconds, a live handler is failed out at
    // the expiry and its job re-run — a duplicate post.
    const queue = rows.rows[0] as {
      expire_seconds: number;
      heartbeat_seconds: number | null;
      retry_limit: number;
      retry_delay: number;
      dead_letter: string;
    };
    expect(queue.expire_seconds).toBe(PUBLISH_QUEUE_OPTIONS.expireInSeconds);
    expect(queue.heartbeat_seconds).toBe(PUBLISH_QUEUE_OPTIONS.heartbeatSeconds);
    expect(queue.retry_limit).toBe(PUBLISH_QUEUE_OPTIONS.retryLimit);
    expect(queue.retry_delay).toBe(PUBLISH_QUEUE_OPTIONS.retryDelay);
    expect(queue.dead_letter).toBe(PUBLISH_DLQ);
  });

  it("throws ConflictException (never silently no-ops) when send() returns null for a duplicate (adaptationId, attemptCount) id", async () => {
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);

    const adaptation = {
      id: crypto.randomUUID(),
      orgId: "test-org",
      channelId: crypto.randomUUID(),
      attemptCount: 0,
    };

    // First enqueue at attemptCount 0 succeeds and actually inserts a job.
    await db.transaction(async (tx) => {
      await service.enqueuePublish(tx, adaptation, null);
    });

    // Second enqueue for the SAME adaptation at the SAME attemptCount computes the
    // identical job id. pg-boss suppresses the duplicate (send() -> null); the
    // fix under test must turn that into a thrown ConflictException, not a
    // silent success that would let a caller mark the row "queued" for nothing.
    await expect(
      db.transaction(async (tx) => {
        await service.enqueuePublish(tx, adaptation, null);
      }),
    ).rejects.toThrow(ConflictException);

    const jobs = await db.execute(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'publish' AND data->>'adaptationId' = '${adaptation.id}'`,
    );
    await pool.end();
    // Exactly one job row landed — the rejected second call did not sneak in a
    // second insert, and the first call's job is still there (thrown error rolled
    // back only the caller's own transaction, not the already-committed first one).
    expect((jobs.rows[0] as { n: number }).n).toBe(1);
  });

  it("creates the generate queue with the shared contract's options, dead letter included", async () => {
    const { GENERATE_DLQ, GENERATE_QUEUE } = await import("@pubrick/shared");
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const rows = await db.execute(
      `SELECT expire_seconds, heartbeat_seconds, retry_limit, retry_delay, dead_letter
         FROM pgboss.queue WHERE name = '${GENERATE_QUEUE}'`,
    );
    await pool.end();

    // Read back from the real pgboss.queue row, not from the constants being
    // passed: createQueue is an ON CONFLICT DO NOTHING insert, so these values
    // only land because onModuleInit follows it with updateQueue. `dead_letter`
    // is asserted because the brief's snippet omitted it while spec §5 requires
    // it — without it the DLQ consumer never runs and a run whose retries were
    // exhausted sits at `running` on the queue strip forever.
    const queue = rows.rows[0] as {
      expire_seconds: number;
      heartbeat_seconds: number | null;
      retry_limit: number;
      retry_delay: number;
      dead_letter: string;
    };
    expect(queue.expire_seconds).toBe(GENERATE_QUEUE_OPTIONS.expireInSeconds);
    expect(queue.heartbeat_seconds).toBe(GENERATE_QUEUE_OPTIONS.heartbeatSeconds);
    expect(queue.retry_limit).toBe(GENERATE_QUEUE_OPTIONS.retryLimit);
    expect(queue.retry_delay).toBe(GENERATE_QUEUE_OPTIONS.retryDelay);
    expect(queue.dead_letter).toBe(GENERATE_DLQ);
  });

  it("enqueues a generate job in the caller's transaction, grouped by org, and 409s pg-boss's dedupe", async () => {
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);

    const run = { id: crypto.randomUUID(), orgId: `test-org-${crypto.randomUUID()}` };

    await db.transaction(async (tx) => {
      await service.enqueueGenerate(tx, run);
    });

    // A run is enqueued exactly once, so unlike publish there is no attempt
    // count to advance and the id is a pure function of the run id — which is
    // precisely why the null return must surface. Swallowing it would leave a
    // `pipeline_runs` row saying "queued" with nothing behind it.
    await expect(
      db.transaction(async (tx) => {
        await service.enqueueGenerate(tx, run);
      }),
    ).rejects.toThrow(ConflictException);

    const jobs = await db.execute(
      `SELECT count(*)::int AS n, min(group_id) AS group_id FROM pgboss.job
         WHERE name = 'generate' AND data->>'runId' = '${run.id}'`,
    );
    await pool.end();
    const row = jobs.rows[0] as { n: number; group_id: string | null };
    expect(row.n).toBe(1);
    // The group is the ORG: GENERATE_WORK_OPTIONS.groupConcurrency keys on
    // pgboss.job.group_id, so a wrong group here would silently let one org
    // saturate every worker slot in the cluster.
    expect(row.group_id).toBe(run.orgId);
  });
});
