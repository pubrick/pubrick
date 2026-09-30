import { generatePaidReply, ProviderPreflightTransientError, type UsageRecord } from "@pubrick/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scopedGoogleFetch, withWorkerAiCall } from "../hosted-ai-call";
import type { PaidReplyRepository } from "./paid-reply.repository";
import { PaidReplyService } from "./paid-reply.service";

vi.mock("./paid-reply.repository", () => ({ PaidReplyRepository: class {} }));
vi.mock("@pubrick/ai", async (original) => ({
  ...(await original<typeof import("@pubrick/ai")>()),
  generatePaidReply: vi.fn(),
}));
vi.mock("../hosted-ai-call", () => ({ withWorkerAiCall: vi.fn(), scopedGoogleFetch: vi.fn() }));
afterEach(() => {
  vi.resetAllMocks();
});
const job = { orgId: "org_paid", attemptId: "attempt_paid" };
function fixture() {
  const repo = {
    claim: vi
      .fn()
      .mockResolvedValue({ request: {}, apiKey: "fixture", proxyUrl: "http://proxy.example:8080" }),
    recordUsage: vi.fn(),
    finish: vi.fn(),
    markUnrecorded: vi.fn(),
  };
  return { repo, service: new PaidReplyService(repo as unknown as PaidReplyRepository) };
}
describe("paid-reply physical admission", () => {
  it("refuses before consuming the one-call claim without claiming phantom provider spend", async () => {
    const { repo, service } = fixture();
    vi.mocked(withWorkerAiCall).mockRejectedValueOnce(
      new ProviderPreflightTransientError("Capacity busy"),
    );
    await expect(service.handle(job)).rejects.toThrow("Capacity busy");
    expect(repo.claim).not.toHaveBeenCalled();
    expect(repo.markUnrecorded).not.toHaveBeenCalled();
    expect(repo.recordUsage).not.toHaveBeenCalled();
    expect(repo.finish).not.toHaveBeenCalled();
    expect(generatePaidReply).not.toHaveBeenCalled();
  });

  it("forwards a scoped native transport and meters before completing the reply", async () => {
    const { repo, service } = fixture();
    const signal = new AbortController().signal;
    const fetcher = vi.fn();
    vi.mocked(scopedGoogleFetch).mockReturnValue(fetcher);
    vi.mocked(withWorkerAiCall).mockImplementationOnce(async (_org, _kind, execute) =>
      execute(signal),
    );
    const record: UsageRecord = {
      provider: "google",
      modelId: "fixture",
      attempt: 1,
      inputTokens: 1,
      outputTokens: 1,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.01,
      costSource: "price_table",
      responseMs: 1,
      status: "ok",
      outcome: "completed",
    };
    vi.mocked(generatePaidReply).mockImplementationOnce(
      async (_request, _key, onUsage, transport) => {
        expect(transport).toBe(fetcher);
        await onUsage(record);
        return { ok: false, failure: "failed" };
      },
    );
    await service.handle(job);
    expect(withWorkerAiCall).toHaveBeenCalledWith(job.orgId, "text", expect.any(Function));
    expect(scopedGoogleFetch).toHaveBeenCalledWith(signal, "http://proxy.example:8080");
    expect(repo.recordUsage).toHaveBeenCalledWith(job, record);
    expect(repo.recordUsage.mock.invocationCallOrder[0]).toBeLessThan(
      repo.finish.mock.invocationCallOrder[0] as number,
    );
    expect(repo.markUnrecorded).not.toHaveBeenCalled();
  });
});
