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
   * Cancels every still-live publish job for one adaptation, inside the
   * caller's transaction: the adaptation's status change and the cancellation
   * either both land or neither does. Without this, rejecting or rescheduling
   * an already-approved item leaves a live job that still delivers the post at
   * the original time.
   *
   * Jobs are found by PAYLOAD, not by recomputing `publishJobId`. That is not
   * a stylistic choice: the job id encodes the attempt count AT ENQUEUE TIME,
   * and `markPublishing` bumps `attempt_count` on every attempt, so as soon as
   * the worker has picked the job up even once the derived id no longer
   * matches the live job. (Enqueued at count N -> id `<id>:N`; one attempt
   * later the row says N+1, and `<id>:N+1` is an id that has never existed.)
   * Deriving it would silently cancel nothing for exactly the case that needs
   * it most — an adaptation stuck in `publishing` part-way through a transient
   * retry chain.
   *
   * `findJobs` and `cancel` both accept pg-boss's `ConnectionOptions`
   * (`{ db }`) in the installed v12 typings, so both genuinely run on the
   * caller's transaction — verified against pg-boss/dist/manager.d.ts:
   * `findJobs(name, options?: types.FindJobsOptions)` (which extends
   * `ConnectionOptions`) and `cancel(name, id, options?: ConnectionOptions)`.
   * The payload filter compiles to `data @> $1`, and it is org-scoped like
   * every other query in this codebase.
   *
   * Deliberately tolerant of "no such job": cancelling is a best-effort
   * cleanup of a job that may legitimately be gone (already completed, already
   * cancelled, aged out of retention). What must NOT happen is the adaptation
   * staying deliverable, and that is decided by the status write this shares a
   * transaction with — plus the worker's own check that the parent item is not
   * rejected.
   *
   * The caller must still advance `attempt_count` afterwards: a cancelled
   * pg-boss row keeps its id, so re-enqueueing at the same attempt count would
   * be suppressed by `send()`'s ON CONFLICT DO NOTHING (see `publishJobId`).
   */
  async cancelPublish(tx: Tx, adaptationId: string, orgId: string): Promise<void> {
    if (!this.boss) throw new Error("Queue is not started");
    const db = fromDrizzle(tx, sql);
    const jobs = await this.boss.findJobs(PUBLISH_QUEUE, {
      data: { adaptationId, orgId },
      db,
    });
    // Terminal jobs are left alone: `cancel` ignores them anyway (its UPDATE is
    // guarded by `state < completed`), but filtering keeps the id list to the
    // handful of jobs that can actually still run.
    const live = jobs
      .filter((job) => job.state === "created" || job.state === "retry" || job.state === "active")
      .map((job) => job.id);
    if (live.length === 0) return;
    await this.boss.cancel(PUBLISH_QUEUE, live, { db });
  }
}
