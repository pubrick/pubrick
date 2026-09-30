import { embed, embedMany } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiImageCaller } from "./gemini-image.js";
import * as transport from "./google-transport.js";
import { embedKnowledgeBatch, embedKnowledgeText } from "./knowledge-embedding.js";

vi.mock("ai", () => ({ embed: vi.fn(), embedMany: vi.fn() }));
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(embed).mockReset();
  vi.mocked(embedMany).mockReset();
});

describe("native Google request cancellation", () => {
  it.each(["caller", "timeout"] as const)(
    "combines image %s cancellation with its existing two minute timeout",
    async (source) => {
      const caller = new AbortController();
      const timeout = new AbortController();
      const timeoutFactory = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
      let received: AbortSignal | null | undefined;
      const fetch = vi
        .spyOn(transport, "googleProxyFetch")
        .mockImplementation(async (_url, init) => {
          received = init?.signal;
          (source === "caller" ? caller : timeout).abort(new Error(source));

          throw init?.signal?.reason;
        });
      expect(
        await new GeminiImageCaller().call("fake", "image", undefined, undefined, caller.signal),
      ).toMatchObject({ outcome: "unknown" });
      expect(received?.aborted).toBe(true);
      expect(received?.reason.message).toBe(source);
      expect(timeoutFactory).toHaveBeenCalledWith(120_000);
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["text", "batch"] as const)(
    "combines %s embedding cancellation and the thirty second timeout",
    async (kind) => {
      const caller = new AbortController();
      const timeout = new AbortController();
      const timeoutFactory = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
      let received: AbortSignal | undefined;
      vi.mocked(embed).mockImplementationOnce(async (options) => {
        received = options.abortSignal;
        return { embedding: Array(768).fill(0.1), usage: { tokens: 3 } } as Awaited<
          ReturnType<typeof embed>
        >;
      });
      vi.mocked(embedMany).mockImplementationOnce(async (options) => {
        received = options.abortSignal;
        return { embeddings: [Array(768).fill(0.1)], usage: { tokens: 3 } } as Awaited<
          ReturnType<typeof embedMany>
        >;
      });
      if (kind === "text")
        await embedKnowledgeText("fake", "note", "RETRIEVAL_QUERY", undefined, caller.signal);
      else await embedKnowledgeBatch("fake", ["note"], undefined, caller.signal);
      expect(timeoutFactory).toHaveBeenCalledWith(30_000);
      expect(received?.aborted).toBe(false);
      caller.abort(new Error("cancelled"));
      expect(received?.aborted).toBe(true);
      expect(received?.reason.message).toBe("cancelled");
    },
  );
});
