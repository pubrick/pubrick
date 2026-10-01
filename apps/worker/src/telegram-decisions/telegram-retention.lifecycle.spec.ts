import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TelegramRetentionLifecycle } from "./telegram-retention.lifecycle";
import type { TelegramRetentionRepository } from "./telegram-retention.repository";

vi.mock("./telegram-retention.repository", () => ({ TelegramRetentionRepository: class {} }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe("Telegram retention lifecycle", () => {
  it("starts immediately, avoids overlapping ticks and drains admitted work on shutdown", async () => {
    vi.useFakeTimers();
    let settle!: (count: number) => void;
    const batch = new Promise<number>((resolve) => {
      settle = resolve;
    });
    const repository = {
      candidates: vi.fn().mockResolvedValue(["synthetic-org"]),
      sweepOrg: vi.fn().mockReturnValueOnce(batch).mockResolvedValue(0),
    };
    const lifecycle = new TelegramRetentionLifecycle(
      repository as unknown as TelegramRetentionRepository,
    );
    lifecycle.onModuleInit();
    lifecycle.onModuleInit();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(repository.candidates).toHaveBeenCalledTimes(1);
    expect(repository.sweepOrg).toHaveBeenCalledTimes(1);
    let closed = false;
    const close = lifecycle.onModuleDestroy().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    settle(0);
    await close;
    lifecycle.onModuleInit();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(repository.candidates).toHaveBeenCalledTimes(1);
  });
  it("reports generic failures, continues other organizations and retries on the next tick", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
    const repository = {
      candidates: vi
        .fn()
        .mockRejectedValueOnce(new Error("secret SQL"))
        .mockResolvedValue(["first", "second"]),
      sweepOrg: vi.fn().mockRejectedValueOnce(new Error("secret token")).mockResolvedValue(0),
    };
    const lifecycle = new TelegramRetentionLifecycle(
      repository as unknown as TelegramRetentionRepository,
    );
    lifecycle.onModuleInit();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(repository.sweepOrg).toHaveBeenCalledWith("first");
    expect(repository.sweepOrg).toHaveBeenCalledWith("second");
    expect(warn).toHaveBeenCalledWith("Telegram retention scan failed: cleanup_unavailable");
    expect(warn).toHaveBeenCalledWith("Telegram retention batches failed: 1");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(repository.candidates).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    await lifecycle.onModuleDestroy();
  });
});
