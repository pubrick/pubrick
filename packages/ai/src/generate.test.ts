import type { SharedV4ProviderMetadata } from "@ai-sdk/provider";
import { PermanentError, TransientError } from "@pubrick/shared";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateStructured } from "./generate.js";
import type { UsageRecord } from "./usage.js";

const schema = z.object({ headline: z.string() });

// MockLanguageModelV4 takes the NESTED provider-level usage shape; the telemetry
// event the recorder sees is the flat-totals one. Both appear in this file on
// purpose — mixing them up is the easiest mistake here.
const usage = {
  inputTokens: { total: 10, noCache: 8, cacheRead: 2, cacheWrite: 0 },
  outputTokens: { total: 5, text: 3, reasoning: 2 },
};

// In the v4 provider spec `finishReason` is an OBJECT, `{ unified, raw }`, not
// the bare string it was in v2/v3. A string still works at runtime — the SDK
// reads `.unified` and gets undefined, which nothing here depends on — so a mock
// written the old way passes vitest and fails `tsc`. `raw` is required even when
// it is undefined.
const stop = { unified: "stop" as const, raw: undefined };

function textModel(...texts: string[]) {
  const queue = [...texts];
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      // Output resolution only runs for text content — a tool-call part makes
      // `.output` throw NoOutputGeneratedError instead.
      content: [{ type: "text" as const, text: queue.shift() ?? "" }],
      finishReason: stop,
      usage,
      warnings: [],
    }),
  });
}

function metadataModel(text: string, providerMetadata: SharedV4ProviderMetadata) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text" as const, text }],
      finishReason: stop,
      usage,
      warnings: [],
      providerMetadata,
    }),
  });
}

const base = { schema, instructions: "You write posts.", prompt: "autumn menu" };

describe("generateStructured", () => {
  it("returns the parsed object and reports usage", async () => {
    const onUsage = vi.fn();
    const result = await generateStructured({
      ...base,
      model: textModel('{"headline":"Autumn menu"}'),
      onUsage,
    });

    expect(result).toEqual({ headline: "Autumn menu" });
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage.mock.calls[0]?.[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      status: "ok",
    });
  });

  it("reads the flat telemetry totals, not the nested provider shape", async () => {
    // The mock was handed inputTokens.cacheRead = 2 and outputTokens.reasoning = 2;
    // the telemetry event renames both. Reading `usage.inputTokens.total` here
    // would silently produce zeros.
    const onUsage = vi.fn();
    await generateStructured({ ...base, model: textModel('{"headline":"x"}'), onUsage });

    expect(onUsage.mock.calls[0]?.[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 2,
      reasoningTokens: 2,
    });
  });

  it("repairs one schema violation, because the Output path has no repairText hook", async () => {
    const onUsage = vi.fn();
    const result = await generateStructured({
      ...base,
      model: textModel("not json at all", '{"headline":"Fixed"}'),
      onUsage,
    });

    expect(result).toEqual({ headline: "Fixed" });
    expect(onUsage).toHaveBeenCalledTimes(2);
    expect(onUsage.mock.calls[1]?.[0]).toMatchObject({ attempt: 2 });
  });

  it("repairs valid JSON of the wrong shape, not only unparseable text", async () => {
    const onUsage = vi.fn();
    const result = await generateStructured({
      ...base,
      model: textModel('{"nope":1}', '{"headline":"Fixed"}'),
      onUsage,
    });

    expect(result).toEqual({ headline: "Fixed" });
    expect(onUsage).toHaveBeenCalledTimes(2);
  });

  it("feeds the offending text and the validation message back to the model", async () => {
    const prompts: string[] = [];
    const queue = ["not json at all", '{"headline":"Fixed"}'];
    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        prompts.push(JSON.stringify(options.prompt));
        return {
          content: [{ type: "text" as const, text: queue.shift() ?? "" }],
          finishReason: stop,
          usage,
          warnings: [],
        };
      },
    });

    await generateStructured({ ...base, model, onUsage: vi.fn() });

    expect(prompts).toHaveLength(2);
    const repair = prompts[1] ?? "";
    expect(repair).toContain("not json at all");
    expect(repair).toContain("JSON parsing failed");
    // The offending text is model output, so it rides in the user prompt, never
    // in instructions — the v7 prompt boundary.
    expect(repair).toContain("autumn menu");
  });

  it("gives up as permanent after a failed repair", async () => {
    await expect(
      generateStructured({
        schema,
        instructions: "x",
        prompt: "y",
        model: textModel("nope", "still nope"),
        onUsage: vi.fn(),
      }),
    ).rejects.toMatchObject({ name: "PermanentError" });
  });

  it("still records a ledger row when the call errors after the provider counted tokens", async () => {
    // The provider counts tokens before anyone knows whether the answer parses.
    // Both failed attempts must leave a row, or the ledger under-reports spend
    // exactly on the runs a human is most likely to be asked about.
    const rows: UsageRecord[] = [];
    await expect(
      generateStructured({
        ...base,
        model: textModel("nope", "still nope"),
        onUsage: (record) => {
          rows.push(record);
        },
      }),
    ).rejects.toBeInstanceOf(PermanentError);

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.status)).toEqual(["errored", "errored"]);
    expect(rows.map((r) => r.attempt)).toEqual([1, 2]);
    expect(rows.every((r) => r.inputTokens === 10 && r.outputTokens === 5)).toBe(true);
  });

  it("records no row when the call failed before any tokens were counted", async () => {
    const rows: UsageRecord[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({
          message: "unauthorized",
          url: "https://example.invalid",
          requestBodyValues: {},
          statusCode: 401,
        });
      },
    });

    await expect(
      generateStructured({
        ...base,
        model,
        onUsage: (record) => {
          rows.push(record);
        },
      }),
    ).rejects.toBeInstanceOf(PermanentError);
    expect(rows).toEqual([]);
  });

  it("classifies a retryable transport failure as transient", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({
          message: "rate limited",
          url: "https://example.invalid",
          requestBodyValues: {},
          statusCode: 429,
          responseHeaders: { "retry-after": "7" },
        });
      },
    });

    // maxRetries: 0 so the SDK's own exponential backoff does not run; the
    // RetryError wrapping that its retries produce is covered in classify.test.ts.
    const error = await generateStructured({
      ...base,
      model,
      maxRetries: 0,
      onUsage: vi.fn(),
    }).catch((e) => e);
    expect(error).toBeInstanceOf(TransientError);
    expect((error as TransientError).retryAfterSeconds).toBe(7);
  });

  it("fails permanently, without a repair, when the model returns a tool call", async () => {
    // Output resolution runs only for text content, so `.output` throws
    // NoOutputGeneratedError. There is no offending text to quote back, so a
    // repair prompt would be a guess — but the call is still metered.
    const rows: UsageRecord[] = [];
    const model = new MockLanguageModelV4({
      doGenerate: async () => ({
        content: [{ type: "tool-call" as const, toolCallId: "1", toolName: "search", input: "{}" }],
        finishReason: { unified: "tool-calls" as const, raw: undefined },
        usage,
        warnings: [],
      }),
    });

    await expect(
      generateStructured({
        ...base,
        model,
        onUsage: (record) => {
          rows.push(record);
        },
      }),
    ).rejects.toThrow(/tool call instead of text/);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("errored");
  });

  it("takes OpenRouter's reported cost when it is present", async () => {
    const onUsage = vi.fn();
    await generateStructured({
      ...base,
      model: metadataModel('{"headline":"x"}', { openrouter: { usage: { cost: 0.00123 } } }),
      onUsage,
    });

    expect(onUsage.mock.calls[0]?.[0]).toMatchObject({
      costUsd: 0.00123,
      costSource: "provider_reported",
    });
  });

  it("records cost as unknown, never zero, when the optional cost field is absent", async () => {
    // `providerMetadata.openrouter.usage.cost` is optional; its absence is
    // normal. A zero here would be summed into a total that looks authoritative.
    const onUsage = vi.fn();
    await generateStructured({
      ...base,
      model: metadataModel('{"headline":"x"}', { openrouter: { usage: {} } }),
      onUsage,
    });

    expect(onUsage.mock.calls[0]?.[0]).toMatchObject({
      costUsd: null,
      costSource: "unknown",
    });
  });

  it("records a reported zero as reported, because free models really are free", async () => {
    const onUsage = vi.fn();
    await generateStructured({
      ...base,
      model: metadataModel('{"headline":"x"}', { openrouter: { usage: { cost: 0 } } }),
      onUsage,
    });

    expect(onUsage.mock.calls[0]?.[0]).toMatchObject({
      costUsd: 0,
      costSource: "provider_reported",
    });
  });

  it("falls back to the price table, normalizing the SDK's provider id", async () => {
    // The SDK reports `google.generative-ai`; the price table and the ledger's
    // provider column speak our two-value vocabulary.
    const onUsage = vi.fn();
    const model = new MockLanguageModelV4({
      provider: "google.generative-ai",
      modelId: "gemini-3.7-flash",
      doGenerate: async () => ({
        content: [{ type: "text" as const, text: '{"headline":"x"}' }],
        finishReason: stop,
        usage,
        warnings: [],
      }),
    });

    await generateStructured({
      ...base,
      model,
      onUsage,
      now: () => new Date("2026-09-01"),
    });

    expect(onUsage.mock.calls[0]?.[0]).toMatchObject({
      provider: "google",
      modelId: "gemini-3.7-flash",
      costUsd: 0.000026,
      costSource: "price_table",
    });
  });

  it("never registers its telemetry sink globally", async () => {
    // Per-call integrations, not registerTelemetry: the global registry has no
    // unregister, so a sink registered once would still be listening in the next
    // test file — a leak nothing here would ever notice. Asserting the global
    // stays empty is the only check that actually fails if someone "simplifies"
    // this into registerTelemetry.
    const first = vi.fn();
    const second = vi.fn();
    await generateStructured({ ...base, model: textModel('{"headline":"a"}'), onUsage: first });
    await generateStructured({ ...base, model: textModel('{"headline":"b"}'), onUsage: second });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(globalThis.AI_SDK_TELEMETRY_INTEGRATIONS ?? []).toEqual([]);
  });
});
