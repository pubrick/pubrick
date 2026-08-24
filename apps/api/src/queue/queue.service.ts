import {
  ConflictException,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { sql } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";
import { v5 as uuidv5 } from "uuid";
import { env } from "../env";

export const PUBLISH_QUEUE = "publish";
export const PUBLISH_DLQ = "publish-dlq";
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
 * Exported because Task 5 (the worker) must derive this same id to report
 * progress/completion against the job it is actually processing — keep the
 * derivation here as the single source of truth rather than duplicating it.
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
    await boss.createQueue(PUBLISH_DLQ);
    await boss.createQueue(PUBLISH_QUEUE, {
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 3600,
      expireInSeconds: 120,
      deadLetter: PUBLISH_DLQ,
    });
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
}
