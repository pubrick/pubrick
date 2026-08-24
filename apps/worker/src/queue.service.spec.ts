import { PUBLISH_DLQ, PUBLISH_QUEUE, PUBLISH_QUEUE_OPTIONS } from "@pubrick/shared";
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

describe("QueueService.registerHeartbeat", () => {
  it("creates the queue, schedules it every minute, and registers a worker", async () => {
    const boss = bossStub();
    const publish = { handle: vi.fn(), markExhausted: vi.fn() };
    const service = new QueueService(publish as never);
    await service.registerHeartbeat(boss as never);
    expect(boss.createQueue).toHaveBeenCalledWith("heartbeat");
    expect(boss.schedule).toHaveBeenCalledWith("heartbeat", "* * * * *");
    expect(boss.work).toHaveBeenCalledWith("heartbeat", expect.any(Function));
  });
});

describe("QueueService.registerAll", () => {
  it("consumes the shared publish queue with the shared options", async () => {
    const boss = bossStub();
    const service = new QueueService({ handle: vi.fn(), markExhausted: vi.fn() } as never);

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

  it("consumes only the queue pair it is given, so a test consumer cannot eat production jobs", async () => {
    const boss = bossStub();
    const service = new QueueService({ handle: vi.fn(), markExhausted: vi.fn() } as never);

    await service.registerAll(boss as never, { publish: "publish-x", deadLetter: "publish-x-dlq" });

    expect(boss.work).toHaveBeenCalledWith("publish-x", expect.anything(), expect.any(Function));
    const workedQueues = boss.work.mock.calls.map((call) => call[0]);
    expect(workedQueues).not.toContain(PUBLISH_QUEUE);
    expect(workedQueues).not.toContain(PUBLISH_DLQ);
    // The overridden pair must also point its dead letters at the overridden DLQ.
    expect(boss.createQueue).toHaveBeenCalledWith("publish-x", {
      ...PUBLISH_QUEUE_OPTIONS,
      deadLetter: "publish-x-dlq",
    });
  });
});
