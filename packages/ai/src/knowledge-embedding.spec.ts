import { embedMany } from "ai";
import { describe, expect, it, vi } from "vitest";
import { embedKnowledgeBatch } from "./knowledge-embedding.js";

vi.mock("ai", () => ({ embed: vi.fn(), embedMany: vi.fn() }));

describe("knowledge batch embedding", () => {
  it("uses one bounded document embedding call with the fixed model and dimension", async () => {
    vi.mocked(embedMany).mockResolvedValueOnce({
      embeddings: [Array(768).fill(0.1), Array(768).fill(Number.NaN)],
      usage: { tokens: Number.NaN },
    } as Awaited<ReturnType<typeof embedMany>>);
    const result = await embedKnowledgeBatch("fake-key", ["First", "Second"]);
    expect(result).toEqual({
      embeddings: [Array(768).fill(0.1), null],
      tokens: 0,
      tokensKnown: false,
    });
    expect(embedMany).toHaveBeenCalledTimes(1);
    expect(embedMany).toHaveBeenCalledWith(
      expect.objectContaining({
        values: ["First", "Second"],
        maxRetries: 0,
        maxParallelCalls: 1,
        providerOptions: { google: { outputDimensionality: 768, taskType: "RETRIEVAL_DOCUMENT" } },
      }),
    );
  });

  it("rejects count mismatch rather than attaching a vector to the wrong note", async () => {
    vi.mocked(embedMany).mockResolvedValueOnce({
      embeddings: [],
      values: ["First"],
      warnings: [],
      usage: { tokens: 0 },
    } as Awaited<ReturnType<typeof embedMany>>);
    await expect(embedKnowledgeBatch("fake-key", ["First"])).rejects.toThrow(
      "Embedding count mismatch",
    );
    await expect(embedKnowledgeBatch("fake-key", Array(11).fill("note"))).rejects.toThrow("1–10");
  });
});
