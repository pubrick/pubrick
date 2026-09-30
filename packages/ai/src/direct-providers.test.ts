import { aiCredentialUpsertSchema } from "@pubrick/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateStructured } from "./generate.js";
import { DEFAULT_MODELS, resolveModel } from "./provider.js";
import type { UsageRecord } from "./usage.js";

const fixtures = [
  {
    provider: "openai",
    model: "gpt-6-luna",
    url: "https://api.openai.com/v1/responses",
    sdk: "openai.responses",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    url: "https://api.anthropic.com/v1/messages",
    sdk: "anthropic.messages",
  },
  {
    provider: "deepseek",
    model: "deepseek-flash",
    url: "https://api.deepseek.com/chat/completions",
    sdk: "deepseek.chat",
  },
] as const;

function reply(provider: string, text = '{"headline":"Hello"}') {
  const usage = { input_tokens: 10, output_tokens: 5 };
  if (provider === "openai")
    return {
      id: "resp_test",
      object: "response",
      created_at: 1,
      model: "gpt-6-luna",
      status: "completed",
      output: [
        {
          type: "message",
          id: "msg_test",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
      usage: {
        ...usage,
        total_tokens: 15,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens_details: { reasoning_tokens: 0 },
      },
    };
  if (provider === "anthropic")
    return {
      id: "msg_test",
      type: "message",
      model: "claude-sonnet-5-5",
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    };
  return {
    id: "chat_test",
    object: "chat.completion",
    created: 1,
    model: "deepseek-flash",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("direct BYOK providers", () => {
  for (const fixture of fixtures) {
    it(`${fixture.provider} accepts saved credentials and runs the common structured/metered pipeline`, async () => {
      const records: UsageRecord[] = [];
      const fetch = vi.fn(
        async (_url: unknown, _init?: RequestInit) =>
          new Response(JSON.stringify(reply(fixture.provider)), {
            headers: { "content-type": "application/json" },
          }),
      );
      vi.stubGlobal("fetch", fetch);
      if (fixture.provider === "openai")
        vi.stubEnv("OPENAI_BASE_URL", "https://wrong-server.invalid");
      const input = { provider: fixture.provider, apiKey: "sk-fixture-key-not-real" };
      expect(aiCredentialUpsertSchema.parse(input)).toEqual(input);
      const model = resolveModel(input);
      expect(model.provider).toBe(fixture.sdk);
      expect(model.modelId).toBe(fixture.model);
      expect(DEFAULT_MODELS[fixture.provider]).toBe(fixture.model);
      const output = await generateStructured({
        model,
        provider: fixture.provider,
        schema: z.object({ headline: z.string() }),
        instructions: "Return JSON for an editorial draft.",
        prompt: "Say hello",
        maxRetries: 0,
        onUsage: (record) => {
          records.push(record);
        },
      });
      expect(output).toEqual({ headline: "Hello" });
      expect(String(fetch.mock.calls[0]?.[0])).toBe(fixture.url);
      const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
      expect(headers.get(fixture.provider === "anthropic" ? "x-api-key" : "authorization")).toBe(
        fixture.provider === "anthropic" ? input.apiKey : `Bearer ${input.apiKey}`,
      );
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        provider: fixture.provider,
        inputTokens: 10,
        outputTokens: 5,
        costUsd: null,
        costSource: "unknown",
        status: "ok",
      });
      if (fixture.provider === "openai") {
        expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ store: false });
      }
    });
  }

  it.each(fixtures)("$provider meters schema repair separately", async ({ provider }) => {
    const records: UsageRecord[] = [];
    let count = 0;
    const fetch = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(
          JSON.stringify(
            reply(provider, count++ === 0 ? '{"headline":7}' : '{"headline":"Repaired"}'),
          ),
          { headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const output = await generateStructured({
      model: resolveModel({ provider, apiKey: "sk-fixture" }),
      provider,
      schema: z.object({ headline: z.string() }),
      instructions: "Return JSON",
      prompt: "Hi",
      maxRetries: 0,
      onUsage: (record) => {
        records.push(record);
      },
    });
    expect(output).toEqual({ headline: "Repaired" });
    expect(
      records.map(({ attempt, status, provider: billed }) => ({ attempt, status, billed })),
    ).toEqual([
      { attempt: 1, status: "errored", billed: provider },
      { attempt: 2, status: "ok", billed: provider },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    if (provider === "openai")
      for (const [, request] of fetch.mock.calls)
        expect(JSON.parse(String(request?.body)).store).toBe(false);
  });

  it("keeps OpenAI requests stateless without discarding unrelated per-call options", async () => {
    const fetch = vi.fn(
      async (_url: unknown, _init?: RequestInit) =>
        new Response(JSON.stringify(reply("openai")), {
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    await generateStructured({
      model: resolveModel({ provider: "openai", apiKey: "sk-fixture" }),
      provider: "openai",
      schema: z.object({ headline: z.string() }),
      instructions: "Return JSON",
      prompt: "Hi",
      maxRetries: 0,
      providerOptions: { openai: { store: true, metadata: { purpose: "fixture" } } },
      onUsage: () => {},
    });
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      store: false,
      metadata: { purpose: "fixture" },
    });
  });

  it.each(fixtures)(
    "$provider preserves selected model ids and rejects missing keys",
    ({ provider }) => {
      expect(
        resolveModel({ provider, apiKey: "sk-fixture", defaultModel: "custom-vendor-model" })
          .modelId,
      ).toBe("custom-vendor-model");
      expect(() => resolveModel({ provider, apiKey: "  " })).toThrow(/no API key/);
    },
  );
});
