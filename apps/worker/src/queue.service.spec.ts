import { describe, expect, it, vi } from "vitest";
import { QueueService } from "./queue.service";

describe("QueueService.registerHeartbeat", () => {
  it("creates the queue, schedules it every minute, and registers a worker", async () => {
    const boss = {
      createQueue: vi.fn().mockResolvedValue(undefined),
      schedule: vi.fn().mockResolvedValue(undefined),
      work: vi.fn().mockResolvedValue("worker-id"),
    };
    const service = new QueueService();
    await service.registerHeartbeat(boss as never);
    expect(boss.createQueue).toHaveBeenCalledWith("heartbeat");
    expect(boss.schedule).toHaveBeenCalledWith("heartbeat", "* * * * *");
    expect(boss.work).toHaveBeenCalledWith("heartbeat", expect.any(Function));
  });
});
