import { ConflictException } from "@nestjs/common";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

// Type-only: avoids importing "./queue.service" (which imports "../env", validated
// eagerly at module load) before beforeAll() below has set the env vars it needs.
type QueueServiceCtor = typeof import("./queue.service").QueueService;
type QueueServiceInstance = InstanceType<QueueServiceCtor>;

// Not an HTTP e2e spec: exercises QueueService.enqueuePublish() directly against
// a real pg-boss/Postgres instance, so the send()->null->throw branch is proven
// deterministically (two sequential awaits, same id) rather than by racing two
// concurrent HTTP requests and hoping the interleaving lands the same way twice.
describe.skipIf(!url)("QueueService.enqueuePublish", () => {
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
});
