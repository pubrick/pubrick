import { describe, expect, it, vi } from "vitest";
import {
  buildPaidReplyRequest,
  countPaidReplyTokens,
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
});
