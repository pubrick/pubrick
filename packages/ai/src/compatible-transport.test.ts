import { AiTextSelectionChangedError } from "@pubrick/shared";
import { createGuardedLookup } from "guarded-fetch";
import { MockAgent } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { runFailureOf } from "./classify.js";
import { COMPATIBLE_MAX_RESPONSE_BYTES, compatibleFetch } from "./compatible-transport.js";
import { generateStructured } from "./generate.js";
import { resolveModel } from "./provider.js";
import type { UsageRecord } from "./usage.js";

const lookup = vi.hoisted(() => vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]));
vi.mock("node:dns/promises", () => ({ lookup }));
const socketLookup = vi.hoisted(() =>
  vi.fn((...args: unknown[]) => {
    const callback = args.at(-1);
    if (typeof callback !== "function") throw new Error("Missing DNS callback");
    callback(null, [{ address: "127.0.0.1", family: 4 }]);
  }),
);
vi.mock("node:dns", () => ({ lookup: socketLookup, default: { lookup: socketLookup } }));
let agent: MockAgent;
const dispatches: unknown[] = [];
vi.mock("undici", async (original) => {
  const actual = await original<typeof import("undici")>();
  return {
    ...actual,
    fetch: vi.fn((input, init) => {
      dispatches.push(init?.dispatcher);
      // Exercise the actual POST and response parser through Undici's mock
      // dispatcher; separately test the maintained connect-time lookup below.
      return actual.fetch(input, { ...init, dispatcher: agent });
    }),
  };
});
const baseURL = "https://llm.example/v1";
const body = (text = '{"headline":"Hello"}') => ({
  id: "fixture",
  object: "chat.completion",
  created: 1,
  model: "custom-model",
  choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});
beforeEach(() => {
  agent = new MockAgent();
  agent.disableNetConnect();
  dispatches.length = 0;
  lookup.mockReset();
  lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }]);
});
afterEach(async () => {
  await agent.close();
  vi.restoreAllMocks();
});

describe("guarded compatible endpoint", () => {
  it("performs authenticated POST through the checked dispatcher, with local JSON validation and unknown cost", async () => {
    let submitted = "";
    agent
      .get("https://llm.example")
      .intercept({
        path: "/v1/chat/completions",
        method: "POST",
        headers: { authorization: "Bearer fixture-key" },
      })
      .reply(
        200,
        (options) => {
          submitted = String(options.body);
          return body();
        },
        { headers: { "content-type": "application/json" } },
      );
    const records: UsageRecord[] = [];
    const model = resolveModel({
      provider: "openai_compatible",
      apiKey: "fixture-key",
      baseURL,
      defaultModel: "custom-model",
    });
    expect(
      await generateStructured({
        model,
        provider: "openai_compatible",
        schema: z.object({ headline: z.string() }),
        instructions: "JSON",
        prompt: "Hello",
        maxRetries: 0,
        onUsage: (row) => {
          records.push(row);
        },
      }),
    ).toEqual({ headline: "Hello" });
    expect(JSON.parse(submitted)).toMatchObject({
      model: "custom-model",
      response_format: { type: "json_object" },
    });
    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]).toBeTruthy();
    expect(dispatches[0]).not.toBe(agent);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ costSource: "unknown", costUsd: null });
    agent.assertNoPendingInterceptors();
  });

  it.each(["127.0.0.1", "10.0.0.1", "::1", "::ffff:127.0.0.1"])(
    "refuses private DNS %s without dispatch or ledger",
    async (address) => {
      lookup.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);
      const records: UsageRecord[] = [];
      const model = resolveModel({
        provider: "openai_compatible",
        apiKey: "fixture-key",
        baseURL,
        defaultModel: "custom-model",
      });
      const error = await generateStructured({
        model,
        provider: "openai_compatible",
        schema: z.object({ headline: z.string() }),
        instructions: "JSON",
        prompt: "Hello",
        maxRetries: 0,
        onUsage: (row) => {
          records.push(row);
        },
      }).catch((error) => error);
      expect(runFailureOf(error)).toBe("provider_refused");
      expect(dispatches).toEqual([]);
      expect(records).toEqual([]);
    },
  );

  it("checks connect-time DNS again when a previously public hostname rebinds", async () => {
    const checked = createGuardedLookup();
    const error = await new Promise<Error | null>((resolve) =>
      checked("llm.example", { all: true }, (error) => resolve(error)),
    );
    expect(socketLookup).toHaveBeenCalled();
    expect(error).toBeInstanceOf(Error);
  });

  it("never follows redirects or forwards credentials to another origin", async () => {
    agent
      .get("https://llm.example")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(302, "", { headers: { location: "https://attacker.example/collect" } });
    const response = await compatibleFetch(baseURL)(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: { authorization: "Bearer fixture-key" },
      body: "{}",
    });
    expect(response.status).toBe(302);
    expect(dispatches).toHaveLength(1);
    agent.assertNoPendingInterceptors();
  });

  it("cancels oversized responses and refuses streaming before transport", async () => {
    agent
      .get("https://llm.example")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, "x".repeat(COMPATIBLE_MAX_RESPONSE_BYTES + 1));
    const records: UsageRecord[] = [];
    const model = resolveModel({
      provider: "openai_compatible",
      apiKey: "fixture-key",
      baseURL,
      defaultModel: "custom-model",
    });
    const error = await generateStructured({
      model,
      provider: "openai_compatible",
      schema: z.object({ headline: z.string() }),
      instructions: "JSON",
      prompt: "Hello",
      maxRetries: 0,
      onUsage: (row) => {
        records.push(row);
      },
    }).catch((error) => error);
    expect(runFailureOf(error)).toBe("no_structured_output");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ costSource: "unknown", costUsd: null, outcome: "unknown" });
    await expect(model.doStream({ prompt: [] })).rejects.toThrow("nonstreaming");
    expect(dispatches).toHaveLength(1);
  });

  it("repairs invalid JSON through the same endpoint and meters both physical calls", async () => {
    const pool = agent.get("https://llm.example");
    pool
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, body("not-json"), { headers: { "content-type": "application/json" } });
    pool
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(200, body(), { headers: { "content-type": "application/json" } });
    const records: UsageRecord[] = [];
    const model = resolveModel({
      provider: "openai_compatible",
      apiKey: "fixture-key",
      baseURL,
      defaultModel: "custom-model",
    });
    expect(
      await generateStructured({
        model,
        provider: "openai_compatible",
        schema: z.object({ headline: z.string() }),
        instructions: "JSON",
        prompt: "Hello",
        maxRetries: 0,
        onUsage: (row) => {
          records.push(row);
        },
      }),
    ).toEqual({ headline: "Hello" });
    expect(records).toHaveLength(2);
    expect(dispatches).toHaveLength(2);
  });

  it("preserves an externally aborted request before dispatch", async () => {
    const controller = new AbortController();
    const refusal = new DOMException("Cancelled", "AbortError");
    controller.abort(refusal);
    await expect(
      compatibleFetch(baseURL)(`${baseURL}/chat/completions`, {
        method: "POST",
        body: "{}",
        signal: controller.signal,
      }),
    ).rejects.toBe(refusal);
    expect(dispatches).toEqual([]);
  });

  it("retains the first 503 receipt and refuses the newly admitted retry after rotation", async () => {
    agent
      .get("https://llm.example")
      .intercept({ path: "/v1/chat/completions", method: "POST" })
      .reply(
        503,
        { error: { message: "Busy" } },
        { headers: { "content-type": "application/json" } },
      );
    let admissions = 0;
    const records: UsageRecord[] = [];
    const model = resolveModel({
      provider: "openai_compatible",
      apiKey: "fixture-key",
      baseURL,
      defaultModel: "custom-model",
      admitCall: async () => {
        if (++admissions > 1) throw new AiTextSelectionChangedError();
      },
    });
    const error = await generateStructured({
      model,
      provider: "openai_compatible",
      schema: z.object({ headline: z.string() }),
      instructions: "JSON",
      prompt: "Hello",
      maxRetries: 1,
      onUsage: (row) => {
        records.push(row);
      },
    }).catch((error) => error);
    expect(runFailureOf(error)).toBe("configuration_changed");
    expect(admissions).toBe(2);
    expect(dispatches).toHaveLength(1);
    expect(records).toHaveLength(1);
  });
});
