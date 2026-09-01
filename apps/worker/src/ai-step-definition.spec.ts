import {
  defineStep,
  type Material,
  type Step,
  type StepAttribution,
  type StepContext,
  type UsageRecord,
} from "@pubrick/ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * A step defined OUTSIDE `@pubrick/ai`, reached the only way a consumer can.
 *
 * `packages/ai/package.json` declares a single `"."` export and no subpath map,
 * so there is no `@pubrick/ai/steps` to import and no supported deep path into
 * `dist`. Until `defineStep` and `Material` reached the package barrel, a step
 * could only be defined inside the package — which is why the editor-side model
 * call this increment exists for had nowhere to live.
 *
 * So this file imports the package NAME and nothing else, from an app that
 * resolves it through the exports map to `dist` exactly as production does. The
 * same assertions written inside `packages/ai` against `./steps/prompt.js` would
 * pass whatever the barrel said, which is the failure they need to catch.
 *
 * Both halves of the import are load-bearing, in different gates: `defineStep`
 * is a value, so an unexported one fails this test run at module load;
 * `Material` is a type annotated onto the callback below, so an unexported one
 * fails `tsc`.
 */

// The V4 provider spec's usage shape is nested and `finishReason` is an object
// `{ unified, raw }` — a bare string passes vitest and fails `tsc`. Same trap
// every mock in this repo repeats; see apps/worker/src/test/scripted-model.ts.
const usage = {
  inputTokens: { total: 40, noCache: 40, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 12, text: 12, reasoning: 0 },
};
const stop = { unified: "stop" as const, raw: undefined };

/** A model that answers with each queued text in turn. Text, never a tool call. */
function modelReplying(...texts: string[]) {
  const queue = [...texts];
  return new MockLanguageModelV4({
    // The id the price table knows, so the ledger row comes out priced.
    modelId: "gemini-3.7-flash",
    doGenerate: async () => ({
      content: [{ type: "text" as const, text: queue.shift() ?? "" }],
      finishReason: stop,
      usage,
      warnings: [],
    }),
  });
}

/** The system and user halves of one call, split by ROLE. */
function halvesOf(model: MockLanguageModelV4, call = 0): { system: string; user: string } {
  const prompt = (model.doGenerateCalls[call]?.prompt ?? []) as ReadonlyArray<{ role: string }>;
  return {
    system: JSON.stringify(prompt.filter((m) => m.role === "system")),
    user: JSON.stringify(prompt.filter((m) => m.role !== "system")),
  };
}

const VOICE = "VOICE_MARKER dry and concrete";
const NOTE = "NOTE_MARKER the kettle whistles at seven";
const CHANNEL_ID = "3f1f0a1c-0d5b-4f5c-9b7e-2c4a6d8e0f11";

function contextFor(
  model: MockLanguageModelV4,
  onUsage: StepContext["onUsage"] = vi.fn(),
): StepContext {
  return {
    brand: { name: "Kettle and Co", voice: VOICE, audience: null, contentLanguage: "en" },
    model,
    provider: "google",
    onUsage,
    // A consumer-defined step is bounded by its caller, not by the SDK default.
    maxRetries: 0,
  };
}

const postcardSchema = z.object({ body: z.string().min(1) });

/**
 * `Material` annotated here rather than inferred: that is what makes the type
 * half of the barrel a compile-time gate rather than a comment.
 */
const POSTCARD: Step<{ note: string }, { body: string }> = defineStep({
  name: "postcard",
  schema: postcardSchema,
  role: ["You write a one-line postcard."],
  material: (_ctx, input): readonly Material[] => [{ label: "NOTE", text: input.note }],
});

describe("a step defined outside @pubrick/ai", () => {
  it("runs, and returns the schema's value", async () => {
    const model = modelReplying(JSON.stringify({ body: "Kettle's on." }));

    const output = await POSTCARD.run(contextFor(model), { note: NOTE });

    expect(output).toEqual({ body: "Kettle's on." });
  });

  it("carries its own name into the ledger row it causes", async () => {
    const attributions: StepAttribution[] = [];
    const onUsage = vi.fn((_record: UsageRecord, attribution: StepAttribution) => {
      attributions.push(attribution);
    });
    const model = modelReplying(JSON.stringify({ body: "Kettle's on." }));

    await POSTCARD.run(contextFor(model, onUsage), { note: NOTE });

    // No row is unattributed, and the caller could not have named the step even
    // if it wanted to: `run` takes a context, and attribution is not in one.
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(attributions).toEqual([{ step: "postcard" }]);
    expect(onUsage.mock.calls[0]?.[0]).toMatchObject({
      provider: "google",
      modelId: "gemini-3.7-flash",
      status: "ok",
    });
  });

  it("can attribute a per-channel call the way the adapter's own rows are", async () => {
    const attributions: StepAttribution[] = [];
    const perChannel = defineStep<{ note: string }, { body: string }>({
      name: `postcard:${CHANNEL_ID}`,
      channelId: CHANNEL_ID,
      schema: postcardSchema,
      role: ["You write a one-line postcard for one channel."],
      material: (_ctx, input): readonly Material[] => [{ label: "NOTE", text: input.note }],
    });
    const model = modelReplying(JSON.stringify({ body: "Kettle's on." }));

    await perChannel.run(
      contextFor(model, (_record, attribution) => {
        attributions.push(attribution);
      }),
      { note: NOTE },
    );

    expect(attributions).toEqual([{ step: `postcard:${CHANNEL_ID}`, channelId: CHANNEL_ID }]);
  });

  it("exposes the very schema it sends, not a second copy that agrees today", async () => {
    const model = modelReplying(JSON.stringify({ body: "Kettle's on." }));

    await POSTCARD.run(contextFor(model), { note: NOTE });

    // One reference: a caller reading `step.schema` to validate, describe or
    // repair an output is reading the object the model was asked for.
    expect(POSTCARD.schema).toBe(postcardSchema);
    expect(POSTCARD.schema.parse({ body: "x" })).toEqual({ body: "x" });
    expect(() => POSTCARD.schema.parse({ body: "" })).toThrow();
  });

  it("keeps its material out of the instructions", async () => {
    const model = modelReplying(JSON.stringify({ body: "Kettle's on." }));

    await POSTCARD.run(contextFor(model), { note: NOTE });
    const { system, user } = halvesOf(model);

    // The boundary a step defined out here inherits and cannot opt out of: it
    // hands over role lines and material separately and has no say in where
    // either one goes. Org configuration is the system half's alone.
    expect(user).toContain("NOTE_MARKER");
    expect(system).not.toContain("NOTE_MARKER");
    expect(system).toContain("VOICE_MARKER");
    expect(user).not.toContain("VOICE_MARKER");
  });
});
