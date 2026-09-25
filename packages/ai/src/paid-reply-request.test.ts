import { describe, expect, it, vi } from "vitest";
import {
  buildPaidReplyRequest,
  countPaidReplyTokens,
  generatePaidReply,
  PAID_REPLY_MAX_OUTPUT_TOKENS,
} from "./paid-reply-request.js";

describe("paid reply request preflight", () => {
  it("counts the exact frozen generation input and schema with an output cap", async () => {
    const request = buildPaidReplyRequest({
      title: "Audience question",
      comments: ["Does this work?"],
    });
    const generateBody = JSON.parse(request.body);
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      const counted = JSON.parse(String(init.body)).generateContentRequest;
      expect(counted).toEqual({ ...generateBody, model: "models/gemini-3.7-flash" });
      expect(counted.generationConfig.maxOutputTokens).toBe(PAID_REPLY_MAX_OUTPUT_TOKENS);
      expect(counted.generationConfig.responseSchema.properties.sentiment).toBeDefined();
      expect(String(init.body)).not.toContain("test-key");
      expect(init.headers).toMatchObject({ "x-goog-api-key": "test-key" });
      return new Response(JSON.stringify({ totalTokens: 411, promptTokensDetails: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    expect(await countPaidReplyTokens(request, "test-key", fetcher as typeof fetch)).toEqual({
      counted: 411,
      allowance: 709,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:countTokens",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("refuses an empty sample, changed snapshot and unknown count before admission", async () => {
    expect(() => buildPaidReplyRequest({ title: "Title", comments: [] })).toThrow(
      "invalid_paid_reply_sample",
    );
    const request = buildPaidReplyRequest({ title: "Title", comments: ["Reply"] });
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ totalTokens: -1 })));
    await expect(
      countPaidReplyTokens({ ...request, body: "{}" }, "test-key", fetcher),
    ).rejects.toThrow("paid_reply_request_changed");
    expect(fetcher).not.toHaveBeenCalled();
    await expect(countPaidReplyTokens(request, "test-key", fetcher)).rejects.toThrow(
      "paid_reply_count_unavailable",
    );
  });

  it("makes one generation call and persists thought-inclusive usage before returning a result", async () => {
    const request = buildPaidReplyRequest({ title: "Post", comments: ["Helpful?", "Yes"] });
    const events: string[] = [];
    const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(init.body).toBe(request.body);
      events.push("provider");
      return new Response(
        JSON.stringify({
          candidates: [
            {
              finishReason: "STOP",
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      summary: "Helpful response.",
                      sentiment: { positive: 1, neutral: 0, negative: 0 },
                      themes: [{ label: "Helpfulness", mentions: 2 }],
                      feedback: [],
                    }),
                  },
                ],
              },
            },
          ],
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 20,
            thoughtsTokenCount: 10,
            cachedContentTokenCount: 5,
          },
        }),
        { status: 200 },
      );
    });
    const sink = vi.fn(
      async (usage: {
        outputTokens: number;
        reasoningTokens: number;
        costUsd: number | null;
        outcome: string;
      }) => {
        expect(usage).toMatchObject({
          outputTokens: 30,
          reasoningTokens: 10,
          outcome: "completed",
        });
        expect(usage.costUsd).toBeGreaterThan(0);
        events.push("metered");
      },
    );
    const result = await generatePaidReply(request, "test-key", sink, fetcher as typeof fetch);
    events.push("returned");
    expect(result).toMatchObject({ ok: true, result: { summary: "Helpful response." } });
    expect(events).toEqual(["provider", "metered", "returned"]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent",
      expect.objectContaining({ method: "POST", body: request.body }),
    );
  });

  it("records an ambiguous malformed response and never retries the model", async () => {
    const request = buildPaidReplyRequest({ title: "Post", comments: ["Reply"] });
    const fetcher = vi.fn(async () => new Response("broken", { status: 200 }));
    const sink = vi.fn(async () => {});
    expect(await generatePaidReply(request, "test-key", sink, fetcher)).toEqual({
      ok: false,
      failure: "unknown",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(sink).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "unknown", costUsd: null }),
    );
  });
});
