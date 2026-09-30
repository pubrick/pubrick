import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { generateStructured } from "./generate.js";
import { type AiCallScope, resolveModel } from "./provider.js";
import { ProviderPreflightError } from "./provider-preflight.js";
import type { UsageRecord } from "./usage.js";

function reply(text = '{"headline":"Hello"}') {
  return new Response(
    JSON.stringify({
      candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    }),
    { headers: { "content-type": "application/json" } },
  );
}
function harness() {
  const events: string[] = [];
  const controller = new AbortController();
  const scope: AiCallScope = async (execute, _incoming) => {
    events.push("acquire");
    try {
      return await execute(controller.signal);
    } finally {
      events.push("release");
    }
  };
  const admitCall = vi.fn(async () => {
    events.push("admit");
  });
  return { events, controller, scope, admitCall };
}
function generate(
  callScope: AiCallScope,
  admitCall: () => Promise<void>,
  records: UsageRecord[],
  maxRetries = 0,
) {
  return generateStructured({
    model: resolveModel({ provider: "google", apiKey: "fixture", callScope, admitCall }),
    provider: "google",
    schema: z.object({ headline: z.string() }),
    instructions: "JSON",
    prompt: "Hello",
    maxRetries,
    onUsage: (record) => {
      records.push(record);
    },
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("physical provider call scope", () => {
  it("refuses before dispatch without admission or phantom usage", async () => {
    const fetch = vi.fn(async () => reply());
    vi.stubGlobal("fetch", fetch);
    const records: UsageRecord[] = [];
    const admitCall = vi.fn(async () => {});
    const callScope: AiCallScope = async () => {
      throw new ProviderPreflightError("No slot");
    };
    await expect(generate(callScope, admitCall, records)).rejects.toThrow("No slot");
    expect(admitCall).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(records).toEqual([]);
  });

  it("scopes and releases each SDK transport retry, including a failed physical call", async () => {
    const h = harness();
    const fetch = vi
      .fn()
      .mockImplementationOnce(async () => {
        h.events.push("http");
        return new Response('{"error":{"message":"Temporary"}}', { status: 503 });
      })
      .mockImplementationOnce(async () => {
        h.events.push("http");
        return reply();
      });
    vi.stubGlobal("fetch", fetch);
    const records: UsageRecord[] = [];
    await expect(generate(h.scope, h.admitCall, records, 1)).resolves.toEqual({
      headline: "Hello",
    });
    expect(h.events).toEqual([
      "acquire",
      "admit",
      "http",
      "release",
      "acquire",
      "admit",
      "http",
      "release",
    ]);
    expect(records).toHaveLength(2);
    expect(records.map((row) => row.status)).toEqual(["errored", "ok"]);
  });

  it("scopes structured output repair independently", async () => {
    const h = harness();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply('{"wrong":true}'))
      .mockResolvedValueOnce(reply());
    vi.stubGlobal("fetch", fetch);
    const records: UsageRecord[] = [];
    await expect(generate(h.scope, h.admitCall, records)).resolves.toEqual({ headline: "Hello" });
    expect(h.events).toEqual(["acquire", "admit", "release", "acquire", "admit", "release"]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(records).toHaveLength(2);
  });

  it.each(["incoming", "scope"] as const)(
    "forwards %s cancellation without mutating caller parameters",
    async (source) => {
      const h = harness();
      const incoming = new AbortController();
      let received: AbortSignal | null | undefined;
      const fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        received = init?.signal;
        return reply();
      });
      vi.stubGlobal("fetch", fetch);
      const params: LanguageModelV4CallOptions = Object.freeze({
        prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "Hello" }] }],
        abortSignal: incoming.signal,
      });
      await resolveModel({
        provider: "google",
        apiKey: "fixture",
        callScope: h.scope,
        admitCall: h.admitCall,
      }).doGenerate(params);
      expect(params.abortSignal).toBe(incoming.signal);
      expect(received?.aborted).toBe(false);
      (source === "incoming" ? incoming : h.controller).abort(new Error(source));
      expect(received?.aborted).toBe(true);
      expect(received?.reason.message).toBe(source);
    },
  );

  it("preserves nested Vertex authorization and endpoint while scoped", async () => {
    const h = harness();
    const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => reply());
    vi.stubGlobal("fetch", fetch);
    await resolveModel({
      provider: "vertex",
      authMode: "express",
      apiKey: "AQ.fixture",
      defaultModel: "gemini-3.8-flash",
      callScope: h.scope,
    }).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
    });
    expect(String(fetch.mock.calls[0]?.[0])).toContain(
      "aiplatform.googleapis.com/v1/publishers/google/",
    );
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("x-goog-api-key")).toBe("AQ.fixture");
    expect(h.events).toEqual(["acquire", "release"]);
  });

  it("refuses scoped streaming before admission or HTTP", async () => {
    const h = harness();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      resolveModel({
        provider: "google",
        apiKey: "fixture",
        callScope: h.scope,
        admitCall: h.admitCall,
      }).doStream({ prompt: [] }),
    ).rejects.toBeInstanceOf(ProviderPreflightError);
    expect(h.events).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains ordinary streaming for an unscoped self-hosted credential", async () => {
    const fetch = vi.fn(
      async () =>
        new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }),
    );
    vi.stubGlobal("fetch", fetch);
    const admitCall = vi.fn(async () => {});
    const stream = await resolveModel({
      provider: "google",
      apiKey: "fixture",
      admitCall,
    }).doStream({ prompt: [] });
    await stream.stream.cancel();
    expect(admitCall).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
