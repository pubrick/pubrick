import { Injectable, Logger } from "@nestjs/common";
import {
  PUBLISH_DLQ,
  PUBLISH_QUEUE,
  PUBLISH_QUEUE_OPTIONS,
  type PublishJob,
} from "@pubrick/shared";
import type { PgBoss } from "pg-boss";
import { PublishService } from "./publish/publish.service";

export { PUBLISH_DLQ, PUBLISH_QUEUE } from "@pubrick/shared";

/**
 * Which queue pair this worker consumes. Defaults to the shared contract; only
 * tests override it, so a live consumer registered by the worker's own e2e
 * spec cannot eat jobs the api's e2e suite enqueued to the real `publish`
 * queue (turbo runs both packages' tests concurrently against the same
 * database).
 */
export type PublishQueueNames = { publish: string; deadLetter: string };

const DEFAULT_QUEUE_NAMES: PublishQueueNames = {
  publish: PUBLISH_QUEUE,
  deadLetter: PUBLISH_DLQ,
};

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
  async registerAll(boss: PgBoss, names: PublishQueueNames = DEFAULT_QUEUE_NAMES): Promise<void> {
    await this.registerHeartbeat(boss);

    // createQueue is idempotent and race-safe; the dead-letter queue must exist first.
    // Names and options come from @pubrick/shared, the single definition shared with
    // the producer side (apps/api/src/queue/queue.service.ts) — the two apps are
    // separately deployable and never import each other, but they do share packages/*.
    const options = { ...PUBLISH_QUEUE_OPTIONS, deadLetter: names.deadLetter };
    await boss.createQueue(names.deadLetter);
    await boss.createQueue(names.publish, options);
    // createQueue is an ON CONFLICT DO NOTHING insert, so on a database where the
    // queue already exists it keeps the OLD options and a change to
    // PUBLISH_QUEUE_OPTIONS would silently never apply. updateQueue converges it.
    await boss.updateQueue(names.publish, options);

    // groupConcurrency: 1 caps concurrent publishes per channel cluster-wide,
    // respecting Telegram's ~1 message/second-per-chat guidance.
    await boss.work<PublishJob>(
      names.publish,
      { batchSize: 1, groupConcurrency: 1 },
      async ([job]) => {
        if (job) await this.publish.handle(job.data);
      },
    );
    // Retries exhausted: the dead-letter copy records the terminal failure.
    await boss.work<PublishJob>(names.deadLetter, { batchSize: 1 }, async ([job]) => {
      if (job) await this.publish.markExhausted(job.data);
    });
  }
}
