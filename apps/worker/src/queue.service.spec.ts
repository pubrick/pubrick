import {
  GENERATE_DLQ,
  GENERATE_QUEUE,
  GENERATE_QUEUE_OPTIONS,
  GENERATE_WORK_OPTIONS,
  PUBLISH_DLQ,
  PUBLISH_QUEUE,
  PUBLISH_QUEUE_OPTIONS,
} from "@pubrick/shared";
import { describe, expect, it, vi } from "vitest";
import { QueueService } from "./queue.service";

function bossStub() {
  return {
    createQueue: vi.fn().mockResolvedValue(undefined),
    updateQueue: vi.fn().mockResolvedValue(undefined),
    schedule: vi.fn().mockResolvedValue(undefined),
    work: vi.fn().mockResolvedValue("worker-id"),
  };
}

function serviceStub() {
  const publish = { handle: vi.fn(), markExhausted: vi.fn() };
  const generate = { handle: vi.fn(), markExhausted: vi.fn() };
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
