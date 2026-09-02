import { Injectable, Logger } from "@nestjs/common";
import {
  GENERATE_DLQ,
  GENERATE_QUEUE,
  GENERATE_QUEUE_OPTIONS,
  GENERATE_WORK_OPTIONS,
  type GenerateJob,
  PUBLISH_DLQ,
  PUBLISH_QUEUE,
  PUBLISH_QUEUE_OPTIONS,
  type PublishJob,
} from "@pubrick/shared";
import type { PgBoss } from "pg-boss";
import { GenerateService } from "./generate/generate.service";
import { PublishService } from "./publish/publish.service";

export { GENERATE_DLQ, GENERATE_QUEUE, PUBLISH_DLQ, PUBLISH_QUEUE } from "@pubrick/shared";

/**
 * Which queue pairs this worker consumes. Defaults to the shared contract; only
 * tests override them, so a live consumer registered by the worker's own e2e
 * specs cannot eat jobs the api's e2e suite enqueued to the real `publish` or
 * `generate` queues (turbo runs both packages' tests concurrently against the
 * same database).
 *
 * Both pairs are overridable, not just publish's: the generate e2e registers a
 * live consumer for exactly the same reason, and a consumer on the real
 * `generate` queue would pick up the runs `runs.e2e.spec.ts` creates and spend
 * an org's (mock, but still) budget out from under that suite.
 */
export type QueueNames = {
  publish: string;
  publishDeadLetter: string;
  generate: string;
  generateDeadLetter: string;
};

const DEFAULT_QUEUE_NAMES: QueueNames = {
  publish: PUBLISH_QUEUE,
  publishDeadLetter: PUBLISH_DLQ,
  generate: GENERATE_QUEUE,
  generateDeadLetter: GENERATE_DLQ,
};

/**
 * How often the abandoned-run sweep runs.
 *
 * Five minutes, not one: the sweep is a maintenance pass whose whole design is
 * to be LATE — a run only becomes a candidate `ABANDONED_GRACE_SECONDS` after
 * its lease expired, so the poll adds at most a rounding error to a latency
 * already measured in tens of minutes. Running it every minute would multiply
 * the table scans by five and change nothing about when a run recovers.
 */
export const SWEEP_CRON = "*/5 * * * *";

/**
 * The sweep's own queue name, DERIVED from the generate queue rather than named
 * independently.
 *
 * Test isolation is the reason, and it is the same reason the pairs above are
 * overridable at all: turbo runs the api and worker suites concurrently against
 * one database, and a spec that registers a live consumer must not consume
 * production's jobs. Deriving means a suite that overrides `generate` gets a
 * private sweep queue automatically instead of having to remember a fifth name.
 *
 * The sweep those consumers perform is the same global pass whichever queue
 * delivered the tick — `sweepAbandoned` asks whether ANY non-terminal job names
 * a run, never whether a job on some named queue does — so a spare consumer on
 * a private queue cannot reach a verdict a production one would not.
 */
export function sweepQueueOf(generateQueue: string): string {
  return `${generateQueue}-sweep`;
}

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    private readonly publish: PublishService,
    private readonly generate: GenerateService,
  ) {}

  /** Seam for job registration; later plans add real queues alongside heartbeat. */
  async registerHeartbeat(boss: PgBoss): Promise<void> {
    await boss.createQueue("heartbeat");
    await boss.schedule("heartbeat", "* * * * *");
    await boss.work("heartbeat", async () => {
      this.logger.log("heartbeat");
    });
  }

  /**
   * Creates and registers every queue the worker consumes: heartbeat, publish,
   * generate, their DLQs, and the abandoned-run sweep.
   */
  async registerAll(boss: PgBoss, names: QueueNames = DEFAULT_QUEUE_NAMES): Promise<void> {
    await this.registerHeartbeat(boss);

    // createQueue is idempotent and race-safe; the dead-letter queue must exist first.
    // Names and options come from @pubrick/shared, the single definition shared with
    // the producer side (apps/api/src/queue/queue.service.ts) — the two apps are
    // separately deployable and never import each other, but they do share packages/*.
    const publishOptions = { ...PUBLISH_QUEUE_OPTIONS, deadLetter: names.publishDeadLetter };
    await boss.createQueue(names.publishDeadLetter);
    await boss.createQueue(names.publish, publishOptions);
    // createQueue is an ON CONFLICT DO NOTHING insert, so on a database where the
    // queue already exists it keeps the OLD options and a change to
    // PUBLISH_QUEUE_OPTIONS would silently never apply. updateQueue converges it.
    await boss.updateQueue(names.publish, publishOptions);

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
    await boss.work<PublishJob>(names.publishDeadLetter, { batchSize: 1 }, async ([job]) => {
      if (job) await this.publish.markExhausted(job.data);
    });

    const generateOptions = { ...GENERATE_QUEUE_OPTIONS, deadLetter: names.generateDeadLetter };
    await boss.createQueue(names.generateDeadLetter);
    await boss.createQueue(names.generate, generateOptions);
    await boss.updateQueue(names.generate, generateOptions);

    // GENERATE_WORK_OPTIONS, not a literal: `groupConcurrency` is a work() option
    // and cannot live in the queue options, so the two halves of the contract are
    // in different objects and only the shared module keeps them together. The
    // JOB is passed whole rather than just its `data`: the fence token is built
    // from the job's own id, and `signal` is aborted at the expiry that makes a
    // second live handler possible (see GenerateService.handle).
    await boss.work<GenerateJob>(names.generate, { ...GENERATE_WORK_OPTIONS }, async ([job]) => {
      if (job) await this.generate.handle({ id: job.id, data: job.data, signal: job.signal });
    });
    // Retries exhausted: the run is stuck with nothing left to move it.
    await boss.work<GenerateJob>(names.generateDeadLetter, { batchSize: 1 }, async ([job]) => {
      if (job) await this.generate.markExhausted(job.data);
    });

    // And the case where pg-boss will never deliver ANYTHING again. A heartbeat
    // re-dispatch hands a second handler the same job id; when the first one
    // returns — correctly, having lost the fence — pg-boss's wrapper completes
    // that id, which is now the second handler's live incarnation. From then on
    // the run has no job behind it: a throw cannot fail an already-`completed`
    // job, so no retry fires and the dead-letter consumer above never runs. The
    // run would sit at `running` for ever, holding a concurrency slot.
    //
    // A cron job rather than a `setInterval` in main.ts, for the reason every
    // scheduled thing here is one: pg-boss enqueues the tick once and exactly
    // one replica takes it, so the sweep does not multiply by worker count.
    const sweepQueue = sweepQueueOf(names.generate);
    await boss.createQueue(sweepQueue);
    await boss.schedule(sweepQueue, SWEEP_CRON);
    await boss.work(sweepQueue, { batchSize: 1 }, async () => {
      await this.generate.sweepAbandoned();
    });
  }
}
