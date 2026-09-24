import { embedKnowledgeBatch } from "@pubrick/ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeAutoIndexRepository } from "./knowledge-auto-index.repository";
import { KnowledgeAutoIndexService } from "./knowledge-auto-index.service";

vi.mock("@pubrick/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pubrick/ai")>();
  return { ...actual, embedKnowledgeBatch: vi.fn() };
});
vi.mock("../db", () => ({ db: {}, pool: {} }));
vi.mock("../env", () => ({ env: { APP_ENCRYPTION_KEY: "test" } }));

const orgId = "org-1";
const brandId = "brand-1";
const note = { id: "note-1", title: "Fact", content: "Text", revision: "1" };

function fixture() {
  const repo = {
    candidates: vi.fn().mockResolvedValue([{ orgId, brandId }]),
    withIndexLock: vi.fn(async (_org: string, _brand: string, run: () => Promise<void>) => run()),
    unindexed: vi.fn().mockResolvedValue([note]),
    claim: vi.fn().mockResolvedValue(true),
    googleKey: vi.fn().mockResolvedValue("fake-key"),
    recordUsage: vi.fn().mockResolvedValue(undefined),
    saveVector: vi.fn().mockResolvedValue(true),
  };
  return {
    repo,
    service: new KnowledgeAutoIndexService(repo as unknown as KnowledgeAutoIndexRepository),
  };
}

describe("automatic knowledge indexing", () => {
  beforeEach(() => vi.clearAllMocks());

  it("claims before one paid batch and records usage before saving vectors", async () => {
    const { repo, service } = fixture();
    const sequence: string[] = [];
    repo.claim.mockImplementation(async () => {
      sequence.push("claim");
      return true;
    });
    vi.mocked(embedKnowledgeBatch).mockImplementationOnce(async () => {
      sequence.push("provider");
      return { embeddings: [Array(768).fill(0.1)], tokens: 0, tokensKnown: false };
    });
    repo.recordUsage.mockImplementation(async () => {
      sequence.push("ledger");
    });
    repo.saveVector.mockImplementation(async () => {
      sequence.push("vector");
      return true;
    });
    await service.scan(new Date("2026-09-24T00:00:00Z"));
    expect(sequence).toEqual(["claim", "provider", "ledger", "vector"]);
    expect(embedKnowledgeBatch).toHaveBeenCalledWith("fake-key", ["Fact\n\nText"]);
    expect(repo.recordUsage).toHaveBeenCalledWith(orgId, 0, expect.any(Number), "ok", "completed");
  });

  it("never calls Google when a brand is disabled or already claimed", async () => {
    const { repo, service } = fixture();
    repo.candidates.mockResolvedValueOnce([]);
    await service.scan();
    repo.claim.mockResolvedValueOnce(false);
    await service.scan();
    expect(embedKnowledgeBatch).not.toHaveBeenCalled();
    expect(repo.googleKey).not.toHaveBeenCalled();
  });

  it("records an ambiguous provider failure once and keeps notes available for text search", async () => {
    const { repo, service } = fixture();
    vi.mocked(embedKnowledgeBatch).mockRejectedValueOnce(new Error("connection closed"));
    await service.scan();
    expect(repo.recordUsage).toHaveBeenCalledWith(
      orgId,
      0,
      expect.any(Number),
      "errored",
      "unknown",
    );
    expect(repo.saveVector).not.toHaveBeenCalled();
  });

  it("does not attach a vector when the ledger write fails", async () => {
    const { repo, service } = fixture();
    vi.mocked(embedKnowledgeBatch).mockResolvedValueOnce({
      embeddings: [Array(768).fill(0.1)],
      tokens: 0,
      tokensKnown: false,
    });
    repo.recordUsage.mockRejectedValueOnce(new Error("database unavailable"));
    await service.scan();
    expect(repo.saveVector).not.toHaveBeenCalled();
  });
});
