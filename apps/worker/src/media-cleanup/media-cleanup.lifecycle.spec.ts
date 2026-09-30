import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MediaCleanupLifecycle } from "./media-cleanup.lifecycle";
import type { MediaCleanupService } from "./media-cleanup.service";

vi.mock("./media-cleanup.service", () => ({ MediaCleanupService: class {} }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("durable media cleanup lifecycle", () => {
  it("runs at startup and every ten seconds without overlapping admitted batches", async () => {
    vi.useFakeTimers();
    let settle!: () => void;
    const first = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const tick = vi.fn().mockReturnValueOnce(first).mockResolvedValue(undefined);
    const lifecycle = new MediaCleanupLifecycle({ tick } as unknown as MediaCleanupService);
    lifecycle.onModuleInit();
    lifecycle.onModuleInit();
    expect(tick).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(tick).toHaveBeenCalledTimes(1);
    settle();
    await first;
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(10000);
    expect(tick).toHaveBeenCalledTimes(2);
    await lifecycle.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(10000);
    expect(tick).toHaveBeenCalledTimes(2);
  });
  it("shutdown waits for the actual batch and permanently refuses reopening", async () => {
    vi.useFakeTimers();
    let settle!: () => void;
    const batch = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const tick = vi.fn().mockReturnValue(batch);
    const lifecycle = new MediaCleanupLifecycle({ tick } as unknown as MediaCleanupService);
    lifecycle.onModuleInit();
    let closed = false;
    const close = lifecycle.onModuleDestroy().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(20000);
    expect(tick).toHaveBeenCalledTimes(1);
    settle();
    await close;
    lifecycle.onModuleInit();
    await vi.advanceTimersByTimeAsync(20000);
    expect(tick).toHaveBeenCalledTimes(1);
  });
  it("reports closed diagnostics and retries after a rejected poll", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    const tick = vi
      .fn()
      .mockRejectedValueOnce(new Error("password=secret SQL server"))
      .mockResolvedValue(undefined);
    const lifecycle = new MediaCleanupLifecycle({ tick } as unknown as MediaCleanupService);
    lifecycle.onModuleInit();
    await vi.advanceTimersByTimeAsync(10000);
    expect(warning).toHaveBeenCalledWith("Media cleanup poll failed: cleanup_unavailable");
    expect(tick).toHaveBeenCalledTimes(2);
    await lifecycle.onModuleDestroy();
  });
});
