import {
  CLAIM_REVIEW_DLQ,
  CLAIM_REVIEW_QUEUE,
  CLAIM_REVIEW_QUEUE_OPTIONS,
  GENERATE_DLQ,
  GENERATE_QUEUE,
  GENERATE_QUEUE_OPTIONS,
  GENERATE_WORK_OPTIONS,
  MANUAL_TOPIC_PLAN_QUEUE,
  MANUAL_TOPIC_PLAN_QUEUE_OPTIONS,
  PUBLISH_DLQ,
  PUBLISH_QUEUE,
  PUBLISH_QUEUE_OPTIONS,
  RELEVANCE_BATCH_DLQ,
  RELEVANCE_BATCH_QUEUE,
  RELEVANCE_BATCH_QUEUE_OPTIONS,
  RELEVANCE_DLQ,
  RELEVANCE_QUEUE,
  RELEVANCE_QUEUE_OPTIONS,
  RELEVANCE_SCAN_QUEUE,
  RSS_POLL_OPTIONS,
  RSS_POLL_QUEUE,
  RSS_SCAN_QUEUE,
  TOPIC_SUGGESTIONS_DLQ,
  TOPIC_SUGGESTIONS_QUEUE,
  TOPIC_SUGGESTIONS_QUEUE_OPTIONS,
} from "@pubrick/shared";
import { describe, expect, it, vi } from "vitest";
import { publishSweepQueueOf, QueueService, SWEEP_CRON, sweepQueueOf } from "./queue.service";

function bossStub() {
  return {
    createQueue: vi.fn().mockResolvedValue(undefined),
    updateQueue: vi.fn().mockResolvedValue(undefined),
    schedule: vi.fn().mockResolvedValue(undefined),
    work: vi.fn().mockResolvedValue("worker-id"),
  };
}

function serviceStub() {
  const publish = { handle: vi.fn(), markExhausted: vi.fn(), sweepAbandoned: vi.fn() };
  const generate = { handle: vi.fn(), markExhausted: vi.fn(), sweepAbandoned: vi.fn() };
  return { publish, generate, service: new QueueService(publish as never, generate as never) };
}

describe("QueueService.registerHeartbeat", () => {
  it("creates the queue, schedules it every minute, and registers a worker", async () => {
    const boss = bossStub();
    const { service } = serviceStub();
    await service.registerHeartbeat(boss as never);
    expect(boss.createQueue).toHaveBeenCalledWith("heartbeat");
    expect(boss.schedule).toHaveBeenCalledWith("heartbeat", "* * * * *");
    expect(boss.work).toHaveBeenCalledWith("heartbeat", expect.any(Function));
  });
});

describe("QueueService.registerAll", () => {
  it("registers advisory reviews only for production queues and passes the expiry signal", async () => {
    const boss = bossStub();
    const claimReview = { handle: vi.fn(), exhausted: vi.fn(), sweepAbandoned: vi.fn() };
    const { publish, generate } = serviceStub();
    const service = new QueueService(
      publish as never,
      generate as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      claimReview as never,
    );
    await service.registerAll(boss as never);
    expect(boss.createQueue).toHaveBeenCalledWith(CLAIM_REVIEW_DLQ);
    expect(boss.createQueue).toHaveBeenCalledWith(CLAIM_REVIEW_QUEUE, {
      ...CLAIM_REVIEW_QUEUE_OPTIONS,
    });
    expect(boss.updateQueue).toHaveBeenCalledWith(CLAIM_REVIEW_QUEUE, {
      ...CLAIM_REVIEW_QUEUE_OPTIONS,
    });
    const handle = boss.work.mock.calls.find((call) => call[0] === CLAIM_REVIEW_QUEUE)?.[2] as (
      jobs: unknown[],
    ) => Promise<void>;
    const exhausted = boss.work.mock.calls.find((call) => call[0] === CLAIM_REVIEW_DLQ)?.[2] as (
      jobs: unknown[],
    ) => Promise<void>;
    const sweep = boss.work.mock.calls.find(
      (call) => call[0] === "claim-review-sweep",
    )?.[2] as () => Promise<void>;
    const signal = new AbortController().signal;
    const payload = { orgId: "org", reviewId: "review" };
    await handle([{ data: payload, signal }]);
    await exhausted([{ data: payload }]);
    await sweep();
    expect(claimReview.handle).toHaveBeenCalledWith(payload, signal);
    expect(claimReview.exhausted).toHaveBeenCalledWith(payload);
    expect(claimReview.sweepAbandoned).toHaveBeenCalledOnce();
    boss.work.mockClear();
    await service.registerAll(boss as never, {
      publish: "test-publish",
      publishDeadLetter: "test-publish-dlq",
      generate: "test-generate",
      generateDeadLetter: "test-generate-dlq",
    });
    expect(boss.work).not.toHaveBeenCalledWith(
      CLAIM_REVIEW_QUEUE,
      expect.anything(),
      expect.anything(),
    );
  });

  it("schedules daily suggestion discovery only for the production queue set", async () => {
    const boss = bossStub();
    const scan = { scan: vi.fn() };
    const { publish, generate } = serviceStub();
    const service = new QueueService(
      publish as never,
      generate as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      scan as never,
    );
    await service.registerAll(boss as never);
    expect(boss.schedule).toHaveBeenCalledWith("topic-suggestions-scan", "*/15 * * * *");
    const scanHandler = boss.work.mock.calls.find(
      (call) => call[0] === "topic-suggestions-scan",
    )?.[2] as () => Promise<void>;
    await scanHandler();
    expect(scan.scan).toHaveBeenCalledWith(boss);
    boss.schedule.mockClear();
    await service.registerAll(boss as never, {
      publish: "test-publish",
      publishDeadLetter: "test-publish-dlq",
      generate: "test-generate",
      generateDeadLetter: "test-generate-dlq",
    });
    expect(boss.schedule).not.toHaveBeenCalledWith("topic-suggestions-scan", expect.any(String));
  });

  it("registers bounded topic suggestions and their exhausted-job handler", async () => {
    const boss = bossStub();
    const suggestions = { handle: vi.fn(), exhausted: vi.fn() };
    const { publish, generate } = serviceStub();
    const service = new QueueService(
      publish as never,
      generate as never,
      undefined,
      undefined,
      undefined,
      undefined,
      suggestions as never,
    );
    await service.registerAll(boss as never);
    expect(boss.createQueue).toHaveBeenCalledWith(TOPIC_SUGGESTIONS_DLQ);
    expect(boss.createQueue).toHaveBeenCalledWith(TOPIC_SUGGESTIONS_QUEUE, {
      ...TOPIC_SUGGESTIONS_QUEUE_OPTIONS,
    });
    expect(boss.updateQueue).toHaveBeenCalledWith(TOPIC_SUGGESTIONS_QUEUE, {
      ...TOPIC_SUGGESTIONS_QUEUE_OPTIONS,
    });
    expect(boss.work).toHaveBeenCalledWith(
      TOPIC_SUGGESTIONS_QUEUE,
      { batchSize: 1, groupConcurrency: 1 },
      expect.any(Function),
    );
    const handle = boss.work.mock.calls.find(
      (call) => call[0] === TOPIC_SUGGESTIONS_QUEUE,
    )?.[2] as (jobs: unknown[]) => Promise<void>;
    const exhausted = boss.work.mock.calls.find(
      (call) => call[0] === TOPIC_SUGGESTIONS_DLQ,
    )?.[2] as (jobs: unknown[]) => Promise<void>;
    const payload = { orgId: "org", brandId: "brand", requestId: "request" };
    await handle([{ data: payload }]);
    await exhausted([{ data: payload }]);
    expect(suggestions.handle).toHaveBeenCalledWith(payload);
    expect(suggestions.exhausted).toHaveBeenCalledWith(payload);
  });

  it("registers bounded relevance work, hourly scanning, and exhausted-job handling", async () => {
    const boss = bossStub();
    const relevance = {
      handle: vi.fn(),
      scan: vi.fn(),
      exhausted: vi.fn(),
      handleBatch: vi.fn(),
      exhaustedBatch: vi.fn(),
      reconcileBatches: vi.fn(),
    };
    const { publish, generate } = serviceStub();
    const service = new QueueService(
      publish as never,
      generate as never,
      undefined,
      undefined,
      relevance as never,
    );
    await service.registerAll(boss as never);
    expect(boss.createQueue).toHaveBeenCalledWith(RELEVANCE_DLQ);
    expect(boss.createQueue).toHaveBeenCalledWith(RELEVANCE_BATCH_DLQ);
    expect(boss.createQueue).toHaveBeenCalledWith(RELEVANCE_BATCH_QUEUE, {
      ...RELEVANCE_BATCH_QUEUE_OPTIONS,
    });
    expect(boss.schedule).toHaveBeenCalledWith("news-relevance-batch-reconcile", "*/5 * * * *");
    expect(boss.createQueue).toHaveBeenCalledWith(RELEVANCE_QUEUE, { ...RELEVANCE_QUEUE_OPTIONS });
    expect(boss.updateQueue).toHaveBeenCalledWith(RELEVANCE_QUEUE, { ...RELEVANCE_QUEUE_OPTIONS });
    expect(boss.schedule).toHaveBeenCalledWith(RELEVANCE_SCAN_QUEUE, "0 * * * *");
    const handle = boss.work.mock.calls.find((call) => call[0] === RELEVANCE_QUEUE)?.[2] as (
      jobs: unknown[],
    ) => Promise<void>;
    const scan = boss.work.mock.calls.find(
      (call) => call[0] === RELEVANCE_SCAN_QUEUE,
    )?.[2] as () => Promise<void>;
    const exhausted = boss.work.mock.calls.find((call) => call[0] === RELEVANCE_DLQ)?.[2] as (
      jobs: unknown[],
    ) => Promise<void>;
    const payload = { orgId: "org", brandId: "brand", itemId: "item" };
    await handle([{ data: payload }]);
    await scan();
    await exhausted([{ data: payload }]);
    const batchHandle = boss.work.mock.calls.find(
      (call) => call[0] === RELEVANCE_BATCH_QUEUE,
    )?.[2] as (jobs: unknown[]) => Promise<void>;
    const batchExhausted = boss.work.mock.calls.find(
      (call) => call[0] === RELEVANCE_BATCH_DLQ,
    )?.[2] as (jobs: unknown[]) => Promise<void>;
    const reconcile = boss.work.mock.calls.find(
      (call) => call[0] === "news-relevance-batch-reconcile",
    )?.[2] as () => Promise<void>;
    const batchJob = { ...payload, batchId: "batch" };
    await batchHandle([{ data: batchJob }]);
    await batchExhausted([{ data: batchJob }]);
    await reconcile();
    expect(relevance.handle).toHaveBeenCalledWith(payload);
    expect(relevance.scan).toHaveBeenCalledWith(boss);
    expect(relevance.exhausted).toHaveBeenCalledWith(payload);
    expect(relevance.handleBatch).toHaveBeenCalledWith(batchJob);
    expect(relevance.exhaustedBatch).toHaveBeenCalledWith(batchJob);
    expect(relevance.reconcileBatches).toHaveBeenCalledOnce();
  });
  it("registers the RSS poll and scan queues when the RSS service is installed", async () => {
    const boss = bossStub();
    const rss = { handle: vi.fn(), scan: vi.fn() };
    const { publish, generate } = serviceStub();
    const service = new QueueService(publish as never, generate as never, rss as never);
    await service.registerAll(boss as never);

    expect(boss.createQueue).toHaveBeenCalledWith(RSS_POLL_QUEUE, { ...RSS_POLL_OPTIONS });
    expect(boss.updateQueue).toHaveBeenCalledWith(RSS_POLL_QUEUE, { ...RSS_POLL_OPTIONS });
    expect(boss.schedule).toHaveBeenCalledWith(RSS_SCAN_QUEUE, "*/15 * * * *");
    const poll = boss.work.mock.calls.find((call) => call[0] === RSS_POLL_QUEUE)?.[2] as (
      jobs: unknown[],
    ) => Promise<void>;
    const scan = boss.work.mock.calls.find(
      (call) => call[0] === RSS_SCAN_QUEUE,
    )?.[2] as () => Promise<void>;
    const payload = { orgId: "org", sourceId: "source" };
    await poll([{ data: payload }]);
    await scan();
    expect(rss.handle).toHaveBeenCalledWith(payload);
    expect(rss.scan).toHaveBeenCalledWith(boss);
  });

  it("registers a single calendar tick on the default queues", async () => {
    const boss = bossStub();
    const calendar = { scan: vi.fn().mockResolvedValue(undefined) };
    const { publish, generate } = serviceStub();
    const service = new QueueService(
      publish as never,
      generate as never,
      undefined,
      calendar as never,
    );
    await service.registerAll(boss as never);
    expect(boss.createQueue).toHaveBeenCalledWith("calendar-scan");
    expect(boss.schedule).toHaveBeenCalledWith("calendar-scan", "* * * * *");
    const tick = boss.work.mock.calls.find(
      (call) => call[0] === "calendar-scan",
    )?.[2] as () => Promise<void>;
    await tick();
    expect(calendar.scan).toHaveBeenCalledWith(boss);
  });

  it("consumes manual topic planning only on production queues", async () => {
    const boss = bossStub();
    const planner = { scan: vi.fn(), planBrand: vi.fn().mockResolvedValue(1) };
    const { publish, generate } = serviceStub();
    const service = new QueueService(
      publish as never,
      generate as never,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      planner as never,
    );
    await service.registerAll(boss as never);
    expect(boss.createQueue).toHaveBeenCalledWith(MANUAL_TOPIC_PLAN_QUEUE, {
      ...MANUAL_TOPIC_PLAN_QUEUE_OPTIONS,
    });
    expect(boss.updateQueue).toHaveBeenCalledWith(MANUAL_TOPIC_PLAN_QUEUE, {
      ...MANUAL_TOPIC_PLAN_QUEUE_OPTIONS,
    });
    const handler = boss.work.mock.calls.find(
      (call) => call[0] === MANUAL_TOPIC_PLAN_QUEUE,
    )?.[2] as (jobs: { data: { orgId: string; brandId: string } }[]) => Promise<void>;
    await handler([{ data: { orgId: "org", brandId: "brand" } }]);
    expect(planner.planBrand).toHaveBeenCalledWith("org", "brand");

    boss.createQueue.mockClear();
    boss.work.mockClear();
    await service.registerAll(boss as never, {
      publish: "test-publish",
      publishDeadLetter: "test-publish-dlq",
      generate: "test-generate",
      generateDeadLetter: "test-generate-dlq",
    });
    expect(boss.createQueue).not.toHaveBeenCalledWith(MANUAL_TOPIC_PLAN_QUEUE, expect.anything());
    expect(boss.work).not.toHaveBeenCalledWith(
      MANUAL_TOPIC_PLAN_QUEUE,
      expect.anything(),
      expect.any(Function),
    );
  });

  it("consumes the shared publish queue with the shared options", async () => {
    const boss = bossStub();
    const { service } = serviceStub();

    await service.registerAll(boss as never);

    // The queue contract is the one @pubrick/shared declares — the api's
    // producer side reads the exact same constants, so the two cannot drift.
    expect(boss.createQueue).toHaveBeenCalledWith(PUBLISH_DLQ);
    expect(boss.createQueue).toHaveBeenCalledWith(PUBLISH_QUEUE, {
      ...PUBLISH_QUEUE_OPTIONS,
      deadLetter: PUBLISH_DLQ,
    });
    // createQueue is ON CONFLICT DO NOTHING, so an existing queue keeps its old
    // options unless updateQueue converges it.
    expect(boss.updateQueue).toHaveBeenCalledWith(PUBLISH_QUEUE, {
      ...PUBLISH_QUEUE_OPTIONS,
      deadLetter: PUBLISH_DLQ,
    });
    expect(boss.work).toHaveBeenCalledWith(PUBLISH_QUEUE, expect.anything(), expect.any(Function));
    expect(boss.work).toHaveBeenCalledWith(PUBLISH_DLQ, expect.anything(), expect.any(Function));
  });

  it("consumes the shared generate queue with the shared queue AND work options", async () => {
    const boss = bossStub();
    const { service } = serviceStub();

    await service.registerAll(boss as never);

    expect(boss.createQueue).toHaveBeenCalledWith(GENERATE_DLQ);
    expect(boss.createQueue).toHaveBeenCalledWith(GENERATE_QUEUE, {
      ...GENERATE_QUEUE_OPTIONS,
      deadLetter: GENERATE_DLQ,
    });
    expect(boss.updateQueue).toHaveBeenCalledWith(GENERATE_QUEUE, {
      ...GENERATE_QUEUE_OPTIONS,
      deadLetter: GENERATE_DLQ,
    });
    // groupConcurrency is a work() option, not a QueueOptions field: put it in
    // the queue options and createQueue silently drops it (its parameter type is
    // an Omit<> whose excess-property check a spread defeats), leaving nothing at
    // all capping per-org concurrency. Assert it reaches work().
    expect(boss.work).toHaveBeenCalledWith(
      GENERATE_QUEUE,
      { ...GENERATE_WORK_OPTIONS },
      expect.any(Function),
    );
    expect(boss.work).toHaveBeenCalledWith(GENERATE_DLQ, expect.anything(), expect.any(Function));
  });

  it("hands the generate handler the whole job — its id AND its abort signal", async () => {
    const boss = bossStub();
    const { generate, service } = serviceStub();

    await service.registerAll(boss as never);
    const handler = boss.work.mock.calls.find((call) => call[0] === GENERATE_QUEUE)?.[2] as (
      jobs: unknown[],
    ) => Promise<void>;
    const signal = new AbortController().signal;
    await handler([{ id: "job-1", data: { runId: "run-1", orgId: "org-1" }, signal }]);

    // Passing only `job.data` would leave the handler with no job identity to
    // fence on, and it would have to invent one — which is how a fence stops
    // fencing. `signal` is pg-boss's abort for THIS delivery, fired at the expiry
    // that lets a second handler start; dropping it here would silently disarm
    // the earliest stop the handler has.
    expect(generate.handle).toHaveBeenCalledWith({
      id: "job-1",
      data: { runId: "run-1", orgId: "org-1" },
      signal,
    });
  });

  it("puts the abandoned-run sweep on a schedule and consumes its ticks", async () => {
    const boss = bossStub();
    const { generate, service } = serviceStub();

    await service.registerAll(boss as never);

    // Without this the run in the finding's race has nothing left that could
    // ever move it: its job was completed by the handler that lost the fence,
    // so no retry fires and the dead-letter consumer above is never reached.
    // A cron job rather than a timer, so N replicas run one sweep, not N.
    const sweepQueue = sweepQueueOf(GENERATE_QUEUE);
    expect(boss.createQueue).toHaveBeenCalledWith(sweepQueue);
    expect(boss.schedule).toHaveBeenCalledWith(sweepQueue, SWEEP_CRON);
    expect(boss.work).toHaveBeenCalledWith(sweepQueue, expect.anything(), expect.any(Function));

    const tick = boss.work.mock.calls.find((call) => call[0] === sweepQueue)?.[2] as (
      jobs: unknown[],
    ) => Promise<void>;
    await tick([{ id: "tick-1", data: {} }]);
    expect(generate.sweepAbandoned).toHaveBeenCalledTimes(1);
  });

  it("puts the abandoned-publish sweep on a schedule and consumes its ticks", async () => {
    const boss = bossStub();
    const { publish, service } = serviceStub();

    await service.registerAll(boss as never);

    // The publish queue has the same hole and until now had no sweep: an
    // adaptation left in "publishing" with its job completed under it can be
    // moved by nothing — not a retry, not the dead-letter consumer, and not
    // even a re-approve, since `approve` does not target `publishing`.
    const sweepQueue = publishSweepQueueOf(PUBLISH_QUEUE);
    expect(boss.createQueue).toHaveBeenCalledWith(sweepQueue);
    expect(boss.schedule).toHaveBeenCalledWith(sweepQueue, SWEEP_CRON);
    expect(boss.work).toHaveBeenCalledWith(sweepQueue, expect.anything(), expect.any(Function));

    const tick = boss.work.mock.calls.find((call) => call[0] === sweepQueue)?.[2] as (
      jobs: unknown[],
    ) => Promise<void>;
    await tick([{ id: "tick-1", data: {} }]);
    expect(publish.sweepAbandoned).toHaveBeenCalledTimes(1);
  });

  it("keeps the two sweeps on separate queues, one per pair", async () => {
    // Not one tick driving both: a spec overrides the publish pair and the
    // generate pair independently, so a single sweep queue derived from one of
    // them would be the wrong private queue for the other.
    expect(publishSweepQueueOf(PUBLISH_QUEUE)).not.toBe(sweepQueueOf(GENERATE_QUEUE));
  });

  it("gives an overridden generate queue its own sweep queue, so a spec cannot eat production's ticks", async () => {
    const boss = bossStub();
    const { service } = serviceStub();

    await service.registerAll(boss as never, {
      publish: "publish-x",
      publishDeadLetter: "publish-x-dlq",
      generate: "generate-x",
      generateDeadLetter: "generate-x-dlq",
    });

    expect(boss.work).toHaveBeenCalledWith(
      "generate-x-sweep",
      expect.anything(),
      expect.any(Function),
    );
    expect(boss.work.mock.calls.map((call) => call[0])).not.toContain(sweepQueueOf(GENERATE_QUEUE));
  });

  it("gives an overridden publish queue its own sweep queue too", async () => {
    const boss = bossStub();
    const { service } = serviceStub();

    await service.registerAll(boss as never, {
      publish: "publish-x",
      publishDeadLetter: "publish-x-dlq",
      generate: "generate-x",
      generateDeadLetter: "generate-x-dlq",
    });

    expect(boss.work).toHaveBeenCalledWith(
      "publish-x-sweep",
      expect.anything(),
      expect.any(Function),
    );
    expect(boss.work.mock.calls.map((call) => call[0])).not.toContain(
      publishSweepQueueOf(PUBLISH_QUEUE),
    );
  });

  it("consumes only the queue pairs it is given, so a test consumer cannot eat production jobs", async () => {
    const boss = bossStub();
    const { service } = serviceStub();

    await service.registerAll(boss as never, {
      publish: "publish-x",
      publishDeadLetter: "publish-x-dlq",
      generate: "generate-x",
      generateDeadLetter: "generate-x-dlq",
    });

    expect(boss.work).toHaveBeenCalledWith("publish-x", expect.anything(), expect.any(Function));
    expect(boss.work).toHaveBeenCalledWith("generate-x", expect.anything(), expect.any(Function));
    const workedQueues = boss.work.mock.calls.map((call) => call[0]);
    expect(workedQueues).not.toContain(PUBLISH_QUEUE);
    expect(workedQueues).not.toContain(PUBLISH_DLQ);
    expect(workedQueues).not.toContain(GENERATE_QUEUE);
    expect(workedQueues).not.toContain(GENERATE_DLQ);
    // The overridden pairs must also point their dead letters at the overridden DLQs.
    expect(boss.createQueue).toHaveBeenCalledWith("publish-x", {
      ...PUBLISH_QUEUE_OPTIONS,
      deadLetter: "publish-x-dlq",
    });
    expect(boss.createQueue).toHaveBeenCalledWith("generate-x", {
      ...GENERATE_QUEUE_OPTIONS,
      deadLetter: "generate-x-dlq",
    });
  });
});
