import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateStructured } from "./generate.js";

afterEach(() => vi.unstubAllGlobals());

describe("paid reply Google provider contract", () => {
  it("sends the output cap in the actual request and meters thoughts inside it", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: { role: "model", parts: [{ text: '{"summary":"ok"}' }] },
                finishReason: "STOP",
              },
            ],
            usageMetadata: {
              promptTokenCount: 30,
              candidatesTokenCount: 8,
              thoughtsTokenCount: 22,
              totalTokenCount: 60,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );

    const rows: Array<{ outputTokens: number; reasoningTokens: number }> = [];
    const model = createGoogleGenerativeAI({ apiKey: "test-key" })("gemini-3.7-flash");
    const result = await generateStructured({
      model,
      provider: "google",
      schema: z.object({ summary: z.string() }),
      instructions: "Summarize the sampled replies.",
      prompt: "One bounded sample",
      maxOutputTokens: 1024,
      maxRetries: 0,
      repairSchemaErrors: false,
      onUsage: (row) => {
        rows.push(row);
      },
    });

    expect(result).toEqual({ summary: "ok" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ generationConfig: { maxOutputTokens: 1024 } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outputTokens: 30, reasoningTokens: 22 });

    await generateStructured({
      model,
      provider: "google",
      schema: z.object({ summary: z.string() }),
      instructions: "Summarize the sampled replies.",
      prompt: "One bounded sample",
      maxRetries: 0,
      repairSchemaErrors: false,
      onUsage: () => {},
    });
    expect(bodies).toHaveLength(2);
    expect(
      Object.hasOwn(
        (bodies[1] as { generationConfig: object }).generationConfig,
        "maxOutputTokens",
      ),
    ).toBe(false);
  });
});
