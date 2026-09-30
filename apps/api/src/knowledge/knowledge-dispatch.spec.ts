import { HttpException } from "@nestjs/common";
import { type AiCallScope, embedKnowledgeBatch, embedKnowledgeText } from "@pubrick/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hostedAiCallScope } from "../hosted-ai-call";
import type { KnowledgeRepository } from "./knowledge.repository";
import { KnowledgeService } from "./knowledge.service";

vi.mock("../hosted-ai-call", () => ({
  hostedAiCallScope: vi.fn(),
  throwHostedAiRefusal: (error: unknown) => {
    if (error instanceof HttpException) throw error;
  },
}));
vi.mock("@pubrick/ai", async (original) => ({
  ...(await original<typeof import("@pubrick/ai")>()),
  embedKnowledgeBatch: vi.fn(),
  embedKnowledgeText: vi.fn(),
}));
function fixture() {
  const repository = {
    withIndexLock: vi.fn(async (_org: string, _brand: string, execute: () => Promise<unknown>) => execute()),
    indexInput: vi.fn(async () => ({ isActive: true, title: "Title", content: "Content" })),
    unindexed: vi.fn(async () => [{ id: "entry", title: "Title", content: "Content" }]),
    googleKey: vi.fn(async () => "synthetic-key"),
    googleProxy: vi.fn(async () => "http://localhost:12345"),
    recordEmbeddingUsage: vi.fn(),
    setEmbedding: vi.fn(),
    setBatchEmbedding: vi.fn(async () => false),
    unindexedCount: vi.fn(async () => 1),
  };
  // Only the repository methods these two service flows call are substituted.
  return {
    repository,
    service: new KnowledgeService(repository as unknown as KnowledgeRepository),
  };
}
beforeEach(() => vi.clearAllMocks());
describe("knowledge physical dispatch admission", () => {
  it.each(["single", "batch"] as const)(
    "refuses %s indexing before HTTP or usage accounting",
    async (kind) => {
      const { service, repository } = fixture();
      const refusal = new HttpException({ code: "resource_limit" }, 409);
      const scope: AiCallScope = async () => {
        throw refusal;
      };
      vi.mocked(hostedAiCallScope).mockReturnValue(scope);
      const result =
        kind === "single"
          ? service.index("org", "brand", "entry")
          : service.indexBatch("org", "brand");
      await expect(result).rejects.toBe(refusal);
      expect(embedKnowledgeText).not.toHaveBeenCalled();
      expect(embedKnowledgeBatch).not.toHaveBeenCalled();
      expect(repository.recordEmbeddingUsage).not.toHaveBeenCalled();
    },
  );
  it("passes the lease cancellation signal to the native batch request", async () => {
    const { service, repository } = fixture();
    const controller = new AbortController();
    const scope: AiCallScope = async (execute) => execute(controller.signal);
    vi.mocked(hostedAiCallScope).mockReturnValue(scope);
    vi.mocked(embedKnowledgeBatch).mockResolvedValue({
      embeddings: [[1]],
      tokens: 2,
      tokensKnown: true,
    });
    repository.setBatchEmbedding.mockResolvedValue(true);
    await service.indexBatch("org", "brand");
    expect(embedKnowledgeBatch).toHaveBeenCalledWith(
      "synthetic-key",
      ["Title\n\nContent"],
      "http://localhost:12345",
      controller.signal,
    );
    expect(repository.recordEmbeddingUsage).toHaveBeenCalledOnce();
  });
});
