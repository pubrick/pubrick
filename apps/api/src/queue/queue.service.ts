import {
  ConflictException,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { PUBLISH_DLQ, PUBLISH_QUEUE, PUBLISH_QUEUE_OPTIONS } from "@pubrick/shared";
import { sql } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";
import { v5 as uuidv5 } from "uuid";
import { env } from "../env";

export { PUBLISH_DLQ, PUBLISH_QUEUE } from "@pubrick/shared";

/** Stable namespace so a job id is a pure function of (adaptation id, attempt count). */
const JOB_NAMESPACE = "1b671a64-40d5-491e-99b0-da01ff1f3341";

/**
 * Deterministic pg-boss job id for ONE publish attempt of ONE adaptation.
 *
 * Keyed on `(adaptationId, attemptCount)` rather than `adaptationId` alone.
 * pg-boss dedupes `send()` by id via `ON CONFLICT DO NOTHING`, and a failed
 * job's row survives at `state='failed'` for the whole retention window (7
 * days). If the id were a pure function of the adaptation id, re-approving a
 * failed adaptation would recompute the SAME id as the dead job: `send()`
 * would return `null`, nothing would actually enqueue, yet the adaptation
 * would still be marked "queued" — a silent stall the user has no way to
 * notice. Folding `attemptCount` in fixes that: the worker bumps
 * `attemptCount` on failure, so the next approve computes a fresh id and
 * genuinely enqueues, while two concurrent approves of the same
 * still-pending adaptation (same attemptCount) compute the same id and
 * correctly dedupe to a single job.
 *
 * The same reasoning applies to `cancelPublish` below: a cancelled job row
 * ALSO survives under its id, so every caller that cancels an outstanding job
 * must advance `attempt_count` before the adaptation can be enqueued again.
 *
 * Not exported beyond this app: the worker never derives job ids (it is handed
 * the job it is processing by pg-boss), so this stays a single source of truth
 * on the producer side rather than becoming part of the shared contract.
 */
export function publishJobId(adaptationId: string, attemptCount: number): string {
  return uuidv5(`${adaptationId}:${attemptCount}`, JOB_NAMESPACE);
}

type Tx = Parameters<Parameters<typeof import("../db").db.transaction>[0]>[0];

@Injectable()
export class QueueService implements OnModuleInit, OnModuleDestroy {
  private boss?: PgBoss;

  async onModuleInit(): Promise<void> {
    const boss = new PgBoss(env.DATABASE_URL);
    boss.on("error", (err) => console.error("pg-boss error", err));
    await boss.start();
    // createQueue is idempotent and race-safe; the dead-letter queue must exist first.
    // Names/options come from @pubrick/shared so the worker cannot drift from them.
    await boss.createQueue(PUBLISH_DLQ);
    await boss.createQueue(PUBLISH_QUEUE, { ...PUBLISH_QUEUE_OPTIONS });
    // createQueue is an ON CONFLICT DO NOTHING insert: on a database where the
    // queue already exists (any dev box or environment that ran an earlier
    // build) it silently keeps the OLD options, so a change to
    // PUBLISH_QUEUE_OPTIONS would never take effect. updateQueue converges it.
    await boss.updateQueue(PUBLISH_QUEUE, { ...PUBLISH_QUEUE_OPTIONS });
    this.boss = boss;
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss?.stop({ graceful: true });
  }

  /**
   * Enqueue inside the caller's transaction: the status change and the job
   * either both land or neither does. `adaptation.attemptCount` must be the
   * CURRENT attempt count (before this attempt) — see `publishJobId`.
   *
   * `send()` returns `null` when pg-boss suppresses a duplicate id. That is
   * never silently swallowed: it means no job was actually inserted, so
   * treating it as success would let the caller mark the adaptation
   * "queued" while nothing will ever publish. Throwing here rolls back the
   * enclosing transaction (Drizzle rolls back on a thrown error), so the DB
   * never disagrees with the queue — an honest 409 instead of a silent
   * stall. In practice this only fires for a genuine concurrent double
   * submit at the same attempt count; a re-approve after a failure gets a
   * fresh id per `publishJobId` and does not hit this path.
   */
  async enqueuePublish(
    tx: Tx,
    adaptation: { id: string; orgId: string; channelId: string; attemptCount: number },
    scheduledAt: Date | null,
  ): Promise<void> {
    if (!this.boss) throw new Error("Queue is not started");
    const jobId = await this.boss.send(
      PUBLISH_QUEUE,
      { adaptationId: adaptation.id, orgId: adaptation.orgId },
      {
        id: publishJobId(adaptation.id, adaptation.attemptCount),
        startAfter: scheduledAt ?? undefined,
        group: { id: adaptation.channelId },
        db: fromDrizzle(tx, sql),
      },
    );
    if (jobId === null) {
      throw new ConflictException("A publish job for this adaptation is already queued");
    }
  }

  /**
   * Cancels the outstanding publish job for `(adaptationId, attemptCount)`,
   * inside the caller's transaction: the adaptation's status change and the
   * cancellation either both land or neither does. Without this, rejecting or
   * rescheduling an already-approved item leaves a live job that still
   * delivers the post at the original time.
   *
   * `cancel` accepts pg-boss's `ConnectionOptions` (`{ db }`) in the installed
   * v12 typings, so it genuinely runs on the caller's transaction — verified
   * against pg-boss/dist/manager.d.ts:
   * `cancel(name, id, options?: types.ConnectionOptions)`.
   *
   * Deliberately tolerant of "no such job": cancelling is a best-effort
   * cleanup of a job that may legitimately be gone (already completed,
   * already cancelled, aged out of retention). What must NOT happen is the
   * adaptation staying deliverable, and that is decided by the status write
   * this shares a transaction with — plus the worker's own check that the
   * parent item is not rejected.
   *
   * The caller must advance `attempt_count` afterwards: the cancelled job row
   * keeps its id, so re-enqueueing at the same attempt count would be
   * suppressed by `send()`'s ON CONFLICT DO NOTHING (see `publishJobId`).
   */
  async cancelPublish(tx: Tx, adaptationId: string, attemptCount: number): Promise<void> {
    if (!this.boss) throw new Error("Queue is not started");
    await this.boss.cancel(PUBLISH_QUEUE, publishJobId(adaptationId, attemptCount), {
      db: fromDrizzle(tx, sql),
    });
  }
}
