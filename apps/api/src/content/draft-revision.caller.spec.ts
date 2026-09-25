import type { AiCredential, StepBrand } from "@pubrick/ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import { DraftRevisionCaller } from "./draft-revision.caller";
import { DRAFT_REVISION_STEP } from "./draft-revision.step";

class ScriptedCaller extends DraftRevisionCaller {
  constructor(private readonly model: MockLanguageModelV4) {
    super();
  }
  protected override buildModel() {
    return this.model as unknown as ReturnType<DraftRevisionCaller["buildModel"]>;
  }
}

const credential: AiCredential = {
  provider: "google",
  apiKey: "fake-key-never-used",
  defaultModel: null,
};
const brand: StepBrand = {
  name: "Example",
  voice: "plain",
  audience: "readers",
  contentLanguage: "en",
};

describe("whole-draft model boundary", () => {
  it("returns a complete suggestion and attributes its physical call to the shared editor ledger", async () => {
    const model = new MockLanguageModelV4({
      modelId: "gemini-3.7-flash",
      doGenerate: async () => ({
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              title: "A clearer title",
              text: "A revised whole post.",
              reason: "Made the opening clearer.",
            }),
          },
        ],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: {
          inputTokens: { total: 40, noCache: 40, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 12, text: 12, reasoning: 0 },
        },
        warnings: [],
      }),
    });
    const outcome = await new ScriptedCaller(model).run({
      credential,
      brand,
      title: "Original title",
      body: "The original whole post.",
      instruction: "Make the opening clearer.",
    });
    expect(outcome).toMatchObject({
      ok: true,
      title: "A clearer title",
      text: "A revised whole post.",
      reason: "Made the opening clearer.",
    });
    expect(outcome.usage).toHaveLength(1);
    expect(outcome.usage[0]?.attribution.step).toBe(DRAFT_REVISION_STEP);
  });
});
