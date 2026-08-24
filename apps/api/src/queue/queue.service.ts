import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";
import { v5 as uuidv5 } from "uuid";
import { env } from "../env";

export const PUBLISH_QUEUE = "publish";
export const PUBLISH_DLQ = "publish-dlq";
/** Stable namespace so a job id is a pure function of the adaptation id. */
const JOB_NAMESPACE = "1b671a64-40d5-491e-99b0-da01ff1f3341";

export function publishJobId(adaptationId: string): string {
  return uuidv5(adaptationId, JOB_NAMESPACE);
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
   * either both land or neither does. A repeated approve reuses the same job
   * id, so pg-boss suppresses the duplicate and returns null.
   */
  async enqueuePublish(
    tx: Tx,
    adaptation: { id: string; orgId: string; channelId: string },
    scheduledAt: Date | null,
  ): Promise<void> {
    if (!this.boss) throw new Error("Queue is not started");
    await this.boss.send(
      PUBLISH_QUEUE,
      { adaptationId: adaptation.id, orgId: adaptation.orgId },
      {
        id: publishJobId(adaptation.id),
        startAfter: scheduledAt ?? undefined,
        group: { id: adaptation.channelId },
        db: fromDrizzle(tx, sql),
      },
    );
  }
}
