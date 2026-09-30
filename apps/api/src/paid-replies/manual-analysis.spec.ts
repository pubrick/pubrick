import { HttpException } from "@nestjs/common";
import {
  countPaidReplyTokens,
  googleProxyFetch,
  ProviderPreflightTransientError,
} from "@pubrick/ai";
import { admitPaidReplyAttempt } from "@pubrick/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostedAiCallScope, throwHostedAiRefusal } from "../hosted-ai-call";
import { requestManualPaidReplyAnalysis } from "./manual-analysis";

vi.mock("../ai-credentials/ai-credentials.repository", () => ({
  AiCredentialsRepository: class {},
}));
vi.mock("../queue/queue.service", () => ({ QueueService: class {} }));
vi.mock("../db", () => ({ db: {} }));
vi.mock("../env", () => ({
  env: { APP_ENCRYPTION_KEY: "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=" },
}));
vi.mock("@pubrick/ai", async (original) => ({
  ...(await original<typeof import("@pubrick/ai")>()),
  countPaidReplyTokens: vi.fn(),
  googleProxyFetch: vi.fn(),
  pricePaidReplyReservation: vi.fn(() => ({ priceWindow: "fixture", reservedMaxUsd: 0.01 })),
}));
vi.mock("@pubrick/db", async (original) => ({
  ...(await original<typeof import("@pubrick/db")>()),
  admitPaidReplyAttempt: vi.fn(),
}));
vi.mock("../hosted-ai-call", () => ({ hostedAiCallScope: vi.fn(), throwHostedAiRefusal: vi.fn() }));
afterEach(() => {
  vi.resetAllMocks();
});
function fixture() {
  const credentials = {
    getDecrypted: vi
      .fn()
      .mockResolvedValue({ apiKey: "fake-key", proxyUrl: "http://proxy.example:8080" }),
  };
  const queue = { enqueuePaidReplyAnalysis: vi.fn() };
  const args = {
    orgId: "org_manual",
    brandId: "brand_manual",
    targetKind: "source_comment" as const,
    targetId: "target_manual",
    sampleVersion: "version",
    sampleCheckedAt: new Date(),
    title: "Coffee",
    comments: ["Useful guide"],
    lockAndValidateTarget: vi.fn(),
    credentials,
    queue,
  } as unknown as Parameters<typeof requestManualPaidReplyAnalysis>[0];
  return { args, queue };
}
describe("manual paid-reply token probe admission", () => {
  it("surfaces local capacity refusal before HTTP, durable admission or queue writes", async () => {
    const { args, queue } = fixture();
    const refused = new ProviderPreflightTransientError("Capacity busy");
    vi.mocked(hostedAiCallScope).mockReturnValueOnce(async () => {
      throw refused;
    });
    vi.mocked(throwHostedAiRefusal).mockImplementationOnce(() => {
      throw new HttpException({ code: "resource_limit" }, 409);
    });
    await expect(requestManualPaidReplyAnalysis(args)).rejects.toMatchObject({ status: 409 });
    expect(hostedAiCallScope).toHaveBeenCalledWith(args.orgId, "probe");
    expect(countPaidReplyTokens).not.toHaveBeenCalled();
    expect(googleProxyFetch).not.toHaveBeenCalled();
    expect(admitPaidReplyAttempt).not.toHaveBeenCalled();
    expect(queue.enqueuePaidReplyAnalysis).not.toHaveBeenCalled();
  });

  it.each(["scope", "timeout"] as const)(
    "forwards actual %s cancellation with the saved proxy",
    async (source) => {
      const { args } = fixture();
      const scoped = new AbortController();
      const timeout = new AbortController();
      vi.mocked(hostedAiCallScope).mockReturnValueOnce(async (execute) => execute(scoped.signal));
      const received: { signal?: AbortSignal | null } = {};
      vi.mocked(googleProxyFetch).mockImplementationOnce(async (_url, init) => {
        const signal = init?.signal;
        received.signal = signal;
        (source === "scope" ? scoped : timeout).abort(new Error(source));
        throw signal?.reason;
      });
      vi.mocked(countPaidReplyTokens).mockImplementationOnce(async (_request, _key, fetcher) => {
        if (!fetcher) throw new Error("Missing scoped transport");
        await fetcher(
          "https://generativelanguage.googleapis.com/v1beta/models/fixture:countTokens",
          { signal: timeout.signal, method: "POST" },
        );
        return { counted: 1, allowance: 257 };
      });
      await expect(requestManualPaidReplyAnalysis(args)).resolves.toEqual({
        status: "blocked",
        reason: "unknown_spend",
      });
      expect(received.signal?.aborted).toBe(true);
      expect(received.signal?.reason.message).toBe(source);
      expect(googleProxyFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
        "http://proxy.example:8080",
      );
      expect(admitPaidReplyAttempt).not.toHaveBeenCalled();
    },
  );

  it("preserves self-hosted token-count argument shape", async () => {
    const { args } = fixture();
    vi.mocked(hostedAiCallScope).mockReturnValueOnce(undefined);
    vi.mocked(countPaidReplyTokens).mockRejectedValueOnce(new Error("unavailable"));
    await requestManualPaidReplyAnalysis(args);
    expect(countPaidReplyTokens).toHaveBeenCalledWith(
      expect.any(Object),
      "fake-key",
      undefined,
      "http://proxy.example:8080",
    );
    expect(googleProxyFetch).not.toHaveBeenCalled();
  });
});
