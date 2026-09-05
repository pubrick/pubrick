import type { AiCredential, StepBrand } from "@pubrick/ai";
import { APICallError } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";
import {
  classifyRefineFailure,
  REFINE_TIMEOUT_MS,
  RefineCaller,
  refineCallContext,
} from "./refine.caller";
import { REFINE_STEP } from "./refine.step";

/**
 * The refine's live half, driven the way `ai-credentials.probe.spec.ts` drives
 * the Test button's: the ONE production line replaced is `resolveModel`.
 * Everything after it — `refineCallContext`'s two bounds, `refineStep`'s prompt
 * boundary, `generateStructured`'s repair retry and metering, the usage
 * collection, and the failure classification — runs for real, against a mock
 * model. No test here reaches a provider, and none may.
 */

// The V4 provider spec's usage shape is nested and `finishReason` is an object
// `{ unified, raw }` — a bare string passes vitest and fails `tsc`. Every mock
// in this repo repeats this; see `packages/ai/src/generate.test.ts`.
const usage = {
  inputTokens: { total: 40, noCache: 40, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 12, text: 12, reasoning: 0 },
};
const stop = { unified: "stop" as const, raw: undefined };

const CREDENTIAL: AiCredential = {
  provider: "google",
  apiKey: "sk-test-never-used",
  defaultModel: null,
};

const BRAND: StepBrand = {
  name: "Kettle and Co",
  voice: "warm, plain",
  audience: "neighbours",
  contentLanguage: "fr",
};

const INPUT = {
  selection: "Nous ouvrons à sept heures et nous fermons à dix-neuf heures.",
  before: "Café ouvert. ",
  after: " Passez nous voir.",
};

/** A model that replies with each queued text in turn, or throws what is queued. */
function scripted(...replies: (string | Error)[]) {
  const queue = [...replies];
  return new MockLanguageModelV4({
    modelId: "gemini-3.7-flash",
    doGenerate: async () => {
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return {
        content: [{ type: "text" as const, text: next ?? "" }],
        finishReason: stop,
        usage,
        warnings: [],
      };
    },
  });
}

/**
 * The caller with its one network line replaced, and nothing else.
 *
 * `buildModel` is `protected` precisely so a test can do this without the seam
 * widening to swallow the parts worth testing.
 */
class ScriptedCaller extends RefineCaller {
  constructor(private readonly stub: MockLanguageModelV4) {
    super();
  }
  protected override buildModel() {
    return this.stub as unknown as ReturnType<RefineCaller["buildModel"]>;
  }
}

const reply = (text: string, reason = "Coupe deux phrases en une.") =>
  JSON.stringify({ text, reason });

describe("what a refine call is bounded by", () => {
  const context = () =>
    refineCallContext(
      scripted() as unknown as Parameters<typeof refineCallContext>[0],
      "google",
      BRAND,
      () => {},
    );

  /**
   * THE MONEY. Left at the SDK's default of 2, one press buys up to six billed
   * round trips — three transport attempts, each able to meet the repair retry
   * — and the hourly allowance's lock-free design rests on a press costing a
   * small bounded number of ledger rows. At 0 a press writes at most two, so a
   * press admitted at the limit minus one leaves the hour at most two rows
   * over.
   *
   * Asserted here rather than through `run`, because a transport retry cannot
   * be observed without a provider that fails the way a network does.
   */
  it("makes at most two billed round trips per press", () => {
    expect(context().maxRetries).toBe(0);
  });

  /**
   * A PERSON IS WATCHING A SPINNER. `MODEL_CALL_TIMEOUT_MS` is two minutes,
   * which is right for a pipeline step nobody is watching and is a broken
   * screen here.
   *
   * The bound is checked as a bound rather than as the literal 45_000: what
   * must stay true is that this call ends inside the attention span of the
   * person who pressed the button, and that it is long enough for a long body
   * and a reasoning model.
   */
  it("gives up long before the pipeline's own two-minute budget", () => {
    expect(context().timeoutMs).toBe(REFINE_TIMEOUT_MS);
    expect(REFINE_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000);
    expect(REFINE_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });

  /**
   * No caller signal, and the consequence is exact rather than incidental:
   * with only our own budget in play `createCallBudget`'s `abortedBy()` can
   * only ever answer `"timeout"`, so a refine that runs out of time is
   * `timed_out` and never the `cancelled` that would name something nobody
   * did. There is no Cancel button in this increment.
   */
  it("passes no caller signal, so an abort can only ever be our own clock", () => {
    expect(context().abortSignal).toBeUndefined();
  });

  it("bills the credential's provider, never a guess from the model id", () => {
    expect(context().provider).toBe("google");
    expect(context().brand).toEqual(BRAND);
  });
});

describe("what a refine call reports back", () => {
  it("returns the model's replacement and its reason", async () => {
    const model = scripted(reply("Ouvert de 7 h à 19 h."));
    const outcome = await new ScriptedCaller(model).run({
      credential: CREDENTIAL,
      brand: BRAND,
      verb: "shorten",
      input: INPUT,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toBe("Ouvert de 7 h à 19 h.");
    expect(outcome.reason).toBe("Coupe deux phrases en une.");
  });

  /**
   * Every physical round trip, under the step's OWN attribution — which is the
   * string the hourly allowance counts rows by. A caller that named the step
   * itself could name a different one from the ledger's filter, and the limit
   * would then count nothing and refuse nobody while looking exactly like a
   * limit.
   */
  it("reports one usage record per round trip, attributed to the refine step", async () => {
    const model = scripted(reply("Ouvert de 7 h à 19 h."));
    const outcome = await new ScriptedCaller(model).run({
      credential: CREDENTIAL,
      brand: BRAND,
      verb: "warmer",
      input: INPUT,
    });

    expect(outcome.usage).toHaveLength(1);
    expect(outcome.usage[0]?.attribution.step).toBe(REFINE_STEP);
    // Never per-channel work: a `channelId` here would file editor spend
    // against a channel that had nothing to do with it.
    expect(outcome.usage[0]?.attribution.channelId).toBeUndefined();
    expect(outcome.usage[0]?.record.inputTokens).toBe(40);
  });

  /**
   * ONE PRESS, TWO BILLED CALLS. `maxRetries: 0` switches off TRANSPORT
   * retries and leaves `generateStructured`'s repair retry, which fires on a
   * schema violation. The allowance counts rows, so this press must consume
   * two — that is the whole reason it counts rows rather than presses.
   */
  it("reports both round trips when the first reply violated the schema", async () => {
    const model = scripted('{"text": 12}', reply("Ouvert de 7 h à 19 h."));
    const outcome = await new ScriptedCaller(model).run({
      credential: CREDENTIAL,
      brand: BRAND,
      verb: "punchier",
      input: INPUT,
    });

    expect(outcome.ok).toBe(true);
    expect(outcome.usage).toHaveLength(2);
    expect(outcome.usage.map((entry) => entry.record.attempt)).toEqual([1, 2]);
  });

  /**
   * A FAILED PRESS STILL COSTS. The provider counts tokens before anyone knows
   * whether the answer would parse, so a refine that ends in a refusal can have
   * been billed twice — and both rows must reach the caller, or the org's spend
   * is understated and the allowance misses exactly the calls most worth
   * counting.
   */
  it("reports what a failed press spent, on the failure arm too", async () => {
    const model = scripted('{"text": 12}', '{"nope": true}');
    const outcome = await new ScriptedCaller(model).run({
      credential: CREDENTIAL,
      brand: BRAND,
      verb: "shorten",
      input: INPUT,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toBe("failed");
    expect(outcome.usage).toHaveLength(2);
  });

  /**
   * Our own clock, end to end: `AbortSignal.timeout` aborts with a
   * `TimeoutError`, and `classifyAiError` reads that name when no composition
   * site answered — so the arm is reachable in a test without waiting out the
   * real budget.
   */
  it("tells a timeout apart from every other failure", async () => {
    const timeout = new DOMException("The operation timed out.", "TimeoutError");
    const outcome = await new ScriptedCaller(scripted(timeout)).run({
      credential: CREDENTIAL,
      brand: BRAND,
      verb: "shorten",
      input: INPUT,
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure).toBe("timed_out");
    // AND IT STILL COUNTS. A call lost after dispatch may have been generated
    // and billed in full while we were hanging up, so the round trip writes a
    // zero-token record with `outcome: "unknown"` — the one column that tells
    // that apart from a 429 the provider refused before counting anything, and
    // what puts the "≥" on the org's total. It consumes the hourly allowance
    // for the same reason: what is bounded is the money that may have been
    // spent, not the answers that came back.
    expect(outcome.usage).toHaveLength(1);
    expect(outcome.usage[0]?.record.outcome).toBe("unknown");
    expect(outcome.usage[0]?.record.inputTokens).toBe(0);
  });
});

/**
 * The classification, driven by the errors a provider actually throws.
 *
 * Two arms and no more, deliberately: the six refusals this route can answer
 * with are the ones a reader can do something different about, and "the key was
 * rejected", "the model does not exist" and "it refused" are one action —
 * press again, and if it keeps happening go and Test the key, where a real
 * diagnosis lives and where a sentence about the key can be shown safely.
 */
describe("classifyRefineFailure", () => {
  const apiError = (statusCode: number, isRetryable = false) =>
    new APICallError({
      message: `Incorrect API key provided: ${CREDENTIAL.apiKey}`,
      url: "https://example.invalid/v1",
      requestBodyValues: {},
      statusCode,
      isRetryable,
    });

  it("calls a timeout a timeout", () => {
    expect(classifyRefineFailure(new DOMException("timed out", "TimeoutError"))).toBe("timed_out");
  });

  it("calls a rejected key, a missing model and a refusal all `failed`", () => {
    expect(classifyRefineFailure(apiError(401))).toBe("failed");
    expect(classifyRefineFailure(apiError(404))).toBe("failed");
    expect(classifyRefineFailure(apiError(400))).toBe("failed");
  });

  it("calls a rate limit `failed` rather than a timeout", () => {
    // The Test button's own copy of a mapping once reported a timeout AS a
    // rate limit. The two must not be confusable in either direction: this
    // arm blames nobody and offers the same action, but calling it
    // `timed_out` would tell the reader the model never answered when it
    // said, explicitly, that it would not.
    expect(classifyRefineFailure(apiError(429, true))).toBe("failed");
  });

  it("calls an error it cannot place `failed`, never a timeout", () => {
    expect(classifyRefineFailure(new TypeError("undefined is not a function"))).toBe("failed");
    expect(classifyRefineFailure("a string nobody threw on purpose")).toBe("failed");
  });
});
