import { Injectable, Logger } from "@nestjs/common";
import type { PgBoss } from "pg-boss";
import { type PublishJob, PublishService } from "./publish/publish.service";

export const PUBLISH_QUEUE = "publish";
export const PUBLISH_DLQ = "publish-dlq";

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(private readonly publish: PublishService) {}

  /** Seam for job registration; later plans add real queues alongside heartbeat. */
  async registerHeartbeat(boss: PgBoss): Promise<void> {
    await boss.createQueue("heartbeat");
    await boss.schedule("heartbeat", "* * * * *");
    await boss.work("heartbeat", async () => {
      this.logger.log("heartbeat");
    });
  }

  /** Creates and registers every queue the worker consumes: heartbeat, publish, and its DLQ. */
  async registerAll(boss: PgBoss): Promise<void> {
    await this.registerHeartbeat(boss);

    // createQueue is idempotent and race-safe; the dead-letter queue must exist first.
    // Same queue names/options as apps/api/src/queue/queue.service.ts (the producer side) —
    // duplicated rather than imported because the worker and api are separately deployable
    // apps that only share packages/*, never each other.
    await boss.createQueue(PUBLISH_DLQ);
    await boss.createQueue(PUBLISH_QUEUE, {
      retryLimit: 5,
      retryDelay: 30,
      retryBackoff: true,
      retryDelayMax: 3600,
      expireInSeconds: 120,
      deadLetter: PUBLISH_DLQ,
    });

    // groupConcurrency: 1 caps concurrent publishes per channel cluster-wide,
    // respecting Telegram's ~1 message/second-per-chat guidance.
    await boss.work<PublishJob>(
      PUBLISH_QUEUE,
      { batchSize: 1, groupConcurrency: 1 },
      async ([job]) => {
        if (job) await this.publish.handle(job.data);
      },
    );
    // Retries exhausted: the dead-letter copy records the terminal failure.
    await boss.work<PublishJob>(PUBLISH_DLQ, { batchSize: 1 }, async ([job]) => {
      if (job) await this.publish.markExhausted(job.data);
    });
  }
}
