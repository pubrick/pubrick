import { Injectable, Logger, Optional } from "@nestjs/common";
import {
  AUTO_PUBLICATION_COMMENTS_SCAN_QUEUE,
  AUTO_TELEGRAM_COMMENTS_SCAN_QUEUE,
  CLAIM_REVIEW_DLQ,
  CLAIM_REVIEW_QUEUE,
  CLAIM_REVIEW_QUEUE_OPTIONS,
  type ClaimReviewJob,
  GENERATE_DLQ,
  GENERATE_QUEUE,
  GENERATE_QUEUE_OPTIONS,
  GENERATE_WORK_OPTIONS,
  type GenerateJob,
  MANUAL_AUTOPILOT_DLQ,
  MANUAL_AUTOPILOT_QUEUE,
  MANUAL_AUTOPILOT_QUEUE_OPTIONS,
  MANUAL_DIGEST_QUEUE,
  MANUAL_DIGEST_QUEUE_OPTIONS,
  MANUAL_TOPIC_PLAN_DLQ,
  MANUAL_TOPIC_PLAN_QUEUE,
  MANUAL_TOPIC_PLAN_QUEUE_OPTIONS,
  type ManualAutopilotJob,
  type ManualDigestJob,
  type ManualTopicPlanJob,
  PAID_REPLY_ANALYSIS_OPTIONS,
  PAID_REPLY_ANALYSIS_QUEUE,
  type PaidReplyAnalysisJob,
  PUBLISH_DLQ,
  PUBLISH_QUEUE,
  PUBLISH_QUEUE_OPTIONS,
  type PublishJob,
  RELEVANCE_BATCH_DLQ,
  RELEVANCE_BATCH_QUEUE,
  RELEVANCE_BATCH_QUEUE_OPTIONS,
  RELEVANCE_DLQ,
  RELEVANCE_QUEUE,
  RELEVANCE_QUEUE_OPTIONS,
  RELEVANCE_SCAN_QUEUE,
  type RelevanceBatchJob,
  type RelevanceJob,
  RSS_POLL_OPTIONS,
  RSS_POLL_QUEUE,
  RSS_SCAN_QUEUE,
  type RssPollJob,
  TELEGRAM_COMMENTS_OPTIONS,
  TELEGRAM_COMMENTS_QUEUE,
  type TelegramCommentsJob,
  TOPIC_SUGGESTIONS_DLQ,
  TOPIC_SUGGESTIONS_QUEUE,
  TOPIC_SUGGESTIONS_QUEUE_OPTIONS,
  type TopicSuggestionsJob,
  VK_METRICS_OPTIONS,
  VK_METRICS_QUEUE,
  VK_METRICS_SCAN_QUEUE,
  type VkMetricsJob,
} from "@pubrick/shared";
import type { PgBoss } from "pg-boss";
import { AutopilotService } from "./autopilot/autopilot.service";
import { CalendarService } from "./calendar/calendar.service";
import { TopicPlannerService } from "./calendar/topic-planner.service";
import { ClaimReviewService } from "./claim-review/claim-review.service";
import { CommentsService } from "./comments/comments.service";
import { PaidReplyService } from "./comments/paid-reply.service";
import { env } from "./env";
import { GenerateService } from "./generate/generate.service";
import { KnowledgeAutoIndexService } from "./knowledge/knowledge-auto-index.service";
import { MetricsService } from "./metrics/metrics.service";
import { NotificationsService } from "./notifications/notifications.service";
import { PublishService } from "./publish/publish.service";
import { RelevanceService } from "./relevance/relevance.service";
import { RssService } from "./rss/rss.service";
import { SuggestionsService } from "./suggestions/suggestions.service";
import { SuggestionsScanService } from "./suggestions/suggestions-scan.service";
import { WebhooksService } from "./webhooks/webhooks.service";

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
 * How often the abandoned-work sweeps run — both of them, generate's and
 * publish's.
 *
 * Five minutes, not one: a sweep is a maintenance pass whose whole design is to
 * be LATE — a row only becomes a candidate a whole further grace period after
 * the queue could still have been working on it, so the poll adds at most a
 * rounding error to a latency already measured in tens of minutes. Running it
 * every minute would multiply the table scans by five and change nothing about
 * when anything recovers.
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

/**
 * The publish sweep's own queue, derived from the publish queue for exactly the
 * reason above — and a SEPARATE queue from generate's rather than one tick
 * driving both.
 *
 * The derivation is what makes it separate: a spec overrides the publish pair
 * and the generate pair independently (publish.e2e.spec.ts overrides both and
 * unschedules the sweeps it does not want firing behind its back), so a single
 * shared sweep queue derived from one of them would be the wrong private queue
 * for the other. The passes themselves are independent global scans over
 * different tables, so nothing is lost by ticking them apart.
 */
export function publishSweepQueueOf(publishQueue: string): string {
  return `${publishQueue}-sweep`;
}

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    private readonly publish: PublishService,
    private readonly generate: GenerateService,
    @Optional() private readonly rss?: RssService,
    @Optional() private readonly calendar?: CalendarService,
    @Optional() private readonly relevance?: RelevanceService,
    @Optional() private readonly comments?: CommentsService,
    @Optional() private readonly suggestions?: SuggestionsService,
    @Optional() private readonly autopilot?: AutopilotService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly metrics?: MetricsService,
    @Optional() private readonly knowledgeAutoIndex?: KnowledgeAutoIndexService,
    @Optional() private readonly webhooks?: WebhooksService,
    @Optional() private readonly suggestionsScan?: SuggestionsScanService,
    @Optional() private readonly topicPlanner?: TopicPlannerService,
    @Optional() private readonly claimReview?: ClaimReviewService,
    @Optional() private readonly paidReplies?: PaidReplyService,
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

    // Manual requests always need a consumer and recovery sweep. The optional
    // rollout instant gates only automatic collection handoffs.
    if (this.paidReplies && names === DEFAULT_QUEUE_NAMES) {
      const start = env.PAID_REPLY_DISPATCH_AFTER ? new Date(env.PAID_REPLY_DISPATCH_AFTER) : null;
      await boss.createQueue(PAID_REPLY_ANALYSIS_QUEUE, { ...PAID_REPLY_ANALYSIS_OPTIONS });
      await boss.updateQueue(PAID_REPLY_ANALYSIS_QUEUE, { ...PAID_REPLY_ANALYSIS_OPTIONS });
      await boss.work<PaidReplyAnalysisJob>(
        PAID_REPLY_ANALYSIS_QUEUE,
        { batchSize: 1, groupConcurrency: 1 },
        async ([job]) => {
          if (job) await this.paidReplies?.handle(job.data);
        },
      );
      await boss.createQueue("paid-reply-reconcile");
      await boss.schedule("paid-reply-reconcile", "*/5 * * * *");
      await boss.work("paid-reply-reconcile", { batchSize: 1 }, async () => {
        if (start) await this.paidReplies?.reconcile(boss, start);
        await this.paidReplies?.sweep(boss);
      });
    }

    if (this.claimReview && names === DEFAULT_QUEUE_NAMES) {
      await boss.createQueue(CLAIM_REVIEW_DLQ);
      await boss.createQueue(CLAIM_REVIEW_QUEUE, { ...CLAIM_REVIEW_QUEUE_OPTIONS });
      await boss.updateQueue(CLAIM_REVIEW_QUEUE, { ...CLAIM_REVIEW_QUEUE_OPTIONS });
      await boss.work<ClaimReviewJob>(
        CLAIM_REVIEW_QUEUE,
        { batchSize: 1, groupConcurrency: 1 },
        async ([job]) => {
          if (job) await this.claimReview?.handle(job.data, job.signal);
        },
      );
      await boss.work<ClaimReviewJob>(CLAIM_REVIEW_DLQ, { batchSize: 1 }, async ([job]) => {
        if (job) await this.claimReview?.exhausted(job.data);
      });
      await boss.createQueue("claim-review-sweep");
      await boss.schedule("claim-review-sweep", SWEEP_CRON);
      await boss.work("claim-review-sweep", { batchSize: 1 }, async () => {
        await this.claimReview?.sweepAbandoned();
      });
    }

    if (this.notifications && names === DEFAULT_QUEUE_NAMES) {
      await boss.createQueue(MANUAL_DIGEST_QUEUE, { ...MANUAL_DIGEST_QUEUE_OPTIONS });
      await boss.updateQueue(MANUAL_DIGEST_QUEUE, { ...MANUAL_DIGEST_QUEUE_OPTIONS });
      await boss.work<ManualDigestJob>(MANUAL_DIGEST_QUEUE, { batchSize: 1 }, async ([job]) => {
        if (job) await this.notifications?.sendDigest(job.data);
      });
      await boss.createQueue("notification-scan");
      await boss.schedule("notification-scan", "* * * * *");
      await boss.work("notification-scan", { batchSize: 1 }, async () =>
        this.notifications?.scan(),
      );
      await boss.createQueue("notification-digest-scan");
      await boss.schedule("notification-digest-scan", "*/5 * * * *");
      await boss.work("notification-digest-scan", { batchSize: 1 }, async () =>
        this.notifications?.scanDigests(),
      );
    }

    if (this.webhooks && names === DEFAULT_QUEUE_NAMES) {
      await boss.createQueue("webhook-scan");
      await boss.schedule("webhook-scan", "* * * * *");
      await boss.work("webhook-scan", { batchSize: 1 }, async () => this.webhooks?.scan());
    }

    if (this.knowledgeAutoIndex && names === DEFAULT_QUEUE_NAMES) {
      await boss.createQueue("knowledge-auto-index-scan");
      await boss.schedule("knowledge-auto-index-scan", "0 * * * *");
      await boss.work("knowledge-auto-index-scan", { batchSize: 1 }, async () =>
        this.knowledgeAutoIndex?.scan(),
      );
    }

    if (this.metrics && names === DEFAULT_QUEUE_NAMES) {
      await boss.createQueue(VK_METRICS_QUEUE, { ...VK_METRICS_OPTIONS });
      await boss.updateQueue(VK_METRICS_QUEUE, { ...VK_METRICS_OPTIONS });
      await boss.work<VkMetricsJob>(
        VK_METRICS_QUEUE,
        { batchSize: 1, groupConcurrency: 1 },
        async ([job]) => {
          if (job) await this.metrics?.handle(job.data);
        },
      );
      await boss.createQueue(VK_METRICS_SCAN_QUEUE);
      await boss.schedule(VK_METRICS_SCAN_QUEUE, "0 * * * *");
      await boss.work(VK_METRICS_SCAN_QUEUE, { batchSize: 1 }, async () => {
        await this.metrics?.scan(boss);
      });
    }

    if (this.rss && names === DEFAULT_QUEUE_NAMES) {
      await boss.createQueue(RSS_POLL_QUEUE, { ...RSS_POLL_OPTIONS });
      await boss.updateQueue(RSS_POLL_QUEUE, { ...RSS_POLL_OPTIONS });
      await boss.work<RssPollJob>(
        RSS_POLL_QUEUE,
        { batchSize: 1, groupConcurrency: 1 },
        async ([job]) => {
          if (job) await this.rss?.handle(job.data);
        },
      );
      await boss.createQueue(RSS_SCAN_QUEUE);
      await boss.schedule(RSS_SCAN_QUEUE, "*/15 * * * *");
      await boss.work(RSS_SCAN_QUEUE, { batchSize: 1 }, async () => this.rss?.scan(boss));
    }

    if (this.relevance && names === DEFAULT_QUEUE_NAMES) {
      const reconcileQueue = "news-relevance-batch-reconcile";
      await boss.createQueue(reconcileQueue);
      await boss.schedule(reconcileQueue, "*/5 * * * *");
      await boss.work(reconcileQueue, { batchSize: 1 }, async () =>
        this.relevance?.reconcileBatches(),
      );
      await boss.createQueue(RELEVANCE_BATCH_DLQ);
      await boss.createQueue(RELEVANCE_BATCH_QUEUE, { ...RELEVANCE_BATCH_QUEUE_OPTIONS });
      await boss.updateQueue(RELEVANCE_BATCH_QUEUE, { ...RELEVANCE_BATCH_QUEUE_OPTIONS });
      await boss.work<RelevanceBatchJob>(
        RELEVANCE_BATCH_QUEUE,
        { batchSize: 1, groupConcurrency: 1 },
        async ([job]) => {
          if (job) await this.relevance?.handleBatch(job.data);
        },
      );
      await boss.work<RelevanceBatchJob>(RELEVANCE_BATCH_DLQ, { batchSize: 1 }, async ([job]) => {
        if (job) await this.relevance?.exhaustedBatch(job.data);
      });
      await boss.createQueue(RELEVANCE_DLQ);
      await boss.createQueue(RELEVANCE_QUEUE, { ...RELEVANCE_QUEUE_OPTIONS });
      await boss.updateQueue(RELEVANCE_QUEUE, { ...RELEVANCE_QUEUE_OPTIONS });
      await boss.work<RelevanceJob>(
        RELEVANCE_QUEUE,
        { batchSize: 1, groupConcurrency: 1 },
        async ([job]) => {
          if (job) await this.relevance?.handle(job.data);
        },
      );
      await boss.work<RelevanceJob>(RELEVANCE_DLQ, { batchSize: 1 }, async ([job]) => {
        if (job) await this.relevance?.exhausted(job.data);
      });
      await boss.createQueue(RELEVANCE_SCAN_QUEUE);
      await boss.schedule(RELEVANCE_SCAN_QUEUE, "0 * * * *");
      await boss.work(RELEVANCE_SCAN_QUEUE, { batchSize: 1 }, async () =>
        this.relevance?.scan(boss),
      );
    }

    if (this.comments && names === DEFAULT_QUEUE_NAMES) {
      await boss.createQueue(TELEGRAM_COMMENTS_QUEUE, { ...TELEGRAM_COMMENTS_OPTIONS });
      await boss.updateQueue(TELEGRAM_COMMENTS_QUEUE, { ...TELEGRAM_COMMENTS_OPTIONS });
      await boss.work<TelegramCommentsJob>(
        TELEGRAM_COMMENTS_QUEUE,
        { batchSize: 1, groupConcurrency: 1 },
        async ([job]) => {
          if (job) await this.comments?.handle(job.data);
        },
      );
      await boss.createQueue(AUTO_TELEGRAM_COMMENTS_SCAN_QUEUE);
      await boss.schedule(AUTO_TELEGRAM_COMMENTS_SCAN_QUEUE, "0 * * * *");
      await boss.work(AUTO_TELEGRAM_COMMENTS_SCAN_QUEUE, { batchSize: 1 }, async () => {
        await this.comments?.scanAuto(boss);
      });
      await boss.createQueue(AUTO_PUBLICATION_COMMENTS_SCAN_QUEUE);
      await boss.schedule(AUTO_PUBLICATION_COMMENTS_SCAN_QUEUE, "0 * * * *");
      await boss.work(AUTO_PUBLICATION_COMMENTS_SCAN_QUEUE, { batchSize: 1 }, async () => {
        await this.comments?.scanPublicationsAuto(boss);
      });
    }

    if (this.suggestions && names === DEFAULT_QUEUE_NAMES) {
      await boss.createQueue(TOPIC_SUGGESTIONS_DLQ);
      await boss.createQueue(TOPIC_SUGGESTIONS_QUEUE, { ...TOPIC_SUGGESTIONS_QUEUE_OPTIONS });
      await boss.updateQueue(TOPIC_SUGGESTIONS_QUEUE, { ...TOPIC_SUGGESTIONS_QUEUE_OPTIONS });
      await boss.work<TopicSuggestionsJob>(
        TOPIC_SUGGESTIONS_QUEUE,
        { batchSize: 1, groupConcurrency: 1 },
        async ([job]) => {
          if (job) await this.suggestions?.handle(job.data);
        },
      );
      await boss.work<TopicSuggestionsJob>(
        TOPIC_SUGGESTIONS_DLQ,
        { batchSize: 1 },
        async ([job]) => {
          if (job) await this.suggestions?.exhausted(job.data);
        },
      );
    }

    if (this.suggestionsScan && names === DEFAULT_QUEUE_NAMES) {
      await boss.createQueue("topic-suggestions-scan");
      await boss.schedule("topic-suggestions-scan", "*/15 * * * *");
      await boss.work("topic-suggestions-scan", { batchSize: 1 }, async () => {
        await this.suggestionsScan?.scan(boss);
      });
    }

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

    // And the publish queue's copy of "pg-boss will never deliver ANYTHING
    // again": the same heartbeat re-dispatch, the same `complete()` landing on
    // the live incarnation of a reused job id, and an adaptation left in
    // `publishing` with no job behind it — which `approve` deliberately does
    // not target, so not even a re-approve can move it. The publish sweep
    // differs from the generate one in its verdict, not its shape: an
    // unresolved in-flight claim means the post MAY be live, so such a row is
    // recorded `unknown` rather than `failed` (see
    // `PublishRepository.sweepAbandoned`).
    const publishSweepQueue = publishSweepQueueOf(names.publish);
    await boss.createQueue(publishSweepQueue);
    await boss.schedule(publishSweepQueue, SWEEP_CRON);
    await boss.work(publishSweepQueue, { batchSize: 1 }, async () => {
      await this.publish.sweepAbandoned();
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

    // Private test queues must not consume production calendar ticks.
    if (this.calendar && names === DEFAULT_QUEUE_NAMES) {
      await boss.createQueue("calendar-scan");
      await boss.schedule("calendar-scan", "* * * * *");
      await boss.work("calendar-scan", { batchSize: 1 }, async () => {
        await this.calendar?.scan(boss);
      });
    }
    if (this.topicPlanner && names === DEFAULT_QUEUE_NAMES) {
      await boss.createQueue("topic-planning-scan");
      await boss.schedule("topic-planning-scan", "0 * * * *");
      await boss.work("topic-planning-scan", { batchSize: 1 }, async () => {
        await this.topicPlanner?.scan();
      });
      await boss.createQueue(MANUAL_TOPIC_PLAN_DLQ);
      await boss.createQueue(MANUAL_TOPIC_PLAN_QUEUE, { ...MANUAL_TOPIC_PLAN_QUEUE_OPTIONS });
      await boss.updateQueue(MANUAL_TOPIC_PLAN_QUEUE, { ...MANUAL_TOPIC_PLAN_QUEUE_OPTIONS });
      await boss.work<ManualTopicPlanJob>(
        MANUAL_TOPIC_PLAN_QUEUE,
        { batchSize: 1, groupConcurrency: 1 },
        async ([job]) => {
          if (job) await this.topicPlanner?.handleManual(job.data);
        },
      );
      await boss.work<ManualTopicPlanJob>(
        MANUAL_TOPIC_PLAN_DLQ,
        { batchSize: 1 },
        async ([job]) => {
          if (job) await this.topicPlanner?.exhausted(job.data);
        },
      );
      await boss.createQueue("topic-plan-manual-sweep");
      await boss.schedule("topic-plan-manual-sweep", SWEEP_CRON);
      await boss.work("topic-plan-manual-sweep", { batchSize: 1 }, async () => {
        await this.topicPlanner?.sweepManual();
      });
    }
    if (this.autopilot && names === DEFAULT_QUEUE_NAMES) {
      await boss.createQueue(MANUAL_AUTOPILOT_DLQ);
      await boss.createQueue(MANUAL_AUTOPILOT_QUEUE, { ...MANUAL_AUTOPILOT_QUEUE_OPTIONS });
      await boss.updateQueue(MANUAL_AUTOPILOT_QUEUE, { ...MANUAL_AUTOPILOT_QUEUE_OPTIONS });
      await boss.work<ManualAutopilotJob>(
        MANUAL_AUTOPILOT_QUEUE,
        { batchSize: 1, groupConcurrency: 1 },
        async ([job]) => {
          if (job) await this.autopilot?.handleManual(boss, job.data);
        },
      );
      await boss.work<ManualAutopilotJob>(MANUAL_AUTOPILOT_DLQ, { batchSize: 1 }, async ([job]) => {
        if (job) await this.autopilot?.exhausted(job.data);
      });
      await boss.createQueue("autopilot-manual-sweep");
      await boss.schedule("autopilot-manual-sweep", SWEEP_CRON);
      await boss.work("autopilot-manual-sweep", { batchSize: 1 }, async () => {
        await this.autopilot?.sweepManual();
      });
      await boss.createQueue("autopilot-scan");
      await boss.schedule("autopilot-scan", "*/5 * * * *");
      await boss.work("autopilot-scan", { batchSize: 1 }, async ([job]) => {
        if (job) await this.autopilot?.scan(boss, job.id);
      });
    }
  }
}
