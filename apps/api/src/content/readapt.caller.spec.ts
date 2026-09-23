import type { AiCredential, StepBrand, StepChannel } from "@pubrick/ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { ReadaptCaller } from "./readapt.caller";

const credential: AiCredential = {
  provider: "google",
  apiKey: "unused-test-key",
  defaultModel: null,
};
const brand: StepBrand = {
  name: "Example",
  voice: "clear",
  audience: "readers",
  contentLanguage: "en",
};
const channel: StepChannel = { id: "channel-1", name: "Main", platform: "x" };

function scripted(...replies: string[]) {
  const queue = [...replies];
  return new MockLanguageModelV4({
    modelId: "gemini-3.7-flash",
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: queue.shift() ?? "" }],
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: {
        inputTokens: { total: 40, noCache: 40, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 12, text: 12, reasoning: 0 },
      },
      warnings: [],
    }),
  });
}

class Caller extends ReadaptCaller {
  constructor(private readonly stub: MockLanguageModelV4) {
    super();
  }
  protected override buildModel() {
    return this.stub as unknown as ReturnType<ReadaptCaller["buildModel"]>;
  }
}

const args = {
  credential,
  brand,
  channel,
  masterBody: "A saved source post about an opening.",
  previousBody: "An earlier channel draft.",
};

describe("channel adaptation model boundary", () => {
  it("returns a bounded channel suggestion and attributes the billed call", async () => {
    const result = await new Caller(
      scripted(JSON.stringify({ body: "We are opening today.", reason: "A shorter opening." })),
    ).run(args);
    expect(result).toMatchObject({
      ok: true,
      text: "We are opening today.",
      reason: "A shorter opening.",
    });
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]?.attribution).toEqual({ step: "readapt", channelId: channel.id });
  });

  it("charges a failed length repair but refuses to stage unusable text", async () => {
    const tooLong = JSON.stringify({ body: "x".repeat(281), reason: "Over limit." });
    const result = await new Caller(scripted(tooLong, tooLong)).run(args);
    expect(result.ok).toBe(false);
    expect(result.usage).toHaveLength(2);
  });
});
