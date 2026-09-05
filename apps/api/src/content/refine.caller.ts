import { Injectable } from "@nestjs/common";
import {
  type AiCredential,
  classifyAiError,
  resolveModel,
  runFailureOf,
  type StepAttribution,
  type StepBrand,
  type StepUsageSink,
  type UsageRecord,
} from "@pubrick/ai";
import type { RefineVerb } from "@pubrick/shared";
import { type RefineContext, type RefineInput, type RefineOutput, refineStep } from "./refine.step";

/**
 * How long one refine may take before the budget ends it.
 *
 * `MODEL_CALL_TIMEOUT_MS` (`@pubrick/ai`) is two minutes, and two minutes is
 * right for a pipeline step nobody is watching. Here a PERSON is watching a
 * spinner over a selection they highlighted, and a call still going after
 * forty-five seconds has stopped being a slow answer and become a screen that
 * looks broken. Forty-five leaves room for a long body plus a reasoning model's
 * think time and still ends inside the attention span of the person who pressed
 * the button.
 *
 * It is also the ONLY bound on this call: there is no Cancel button in this
 * increment. That has an exact consequence worth stating rather than
 * discovering — with only our own budget in play, `createCallBudget`'s
 * `abortedBy()` can only ever answer `"timeout"`, so a refine that runs out of
 * time classifies as `timed_out` and never as the `cancelled` that would be a
 * word for something nobody did.
 */
export const REFINE_TIMEOUT_MS = 45_000;

/** One physical model call, with the step identity the ledger row is written under. */
export type RefineUsage = { record: UsageRecord; attribution: StepAttribution };

/**
 * Why a refine produced no proposal, in the two shapes the reader can be told
 * apart from each other.
 *
 * `timed_out` is ours and is actionable in a specific way ("it did not answer;
 * press again"). Everything else the classifier can produce — a rejected key,
 * a model that does not exist, a provider refusal, an answer that would not
 * parse — collapses to `failed`, because the provider's own words are the one
 * thing that must NOT reach the screen: they quote the submitted API key back
 * (see `AI_TEST_FAILURES`), and diagnosing a key is what Settings' Test button
 * is for.
 */
export type RefineFailure = "timed_out" | "failed";

/**
 * What one refine produced, and what it cost either way.
 *
 * `usage` is on BOTH arms, exactly as `ProbeOutcome`'s is and for the same
 * reason: a call that failed after the provider counted tokens was still
 * billed, and a ledger that recorded only the answers we liked would understate
 * the org's spend and hand the hourly allowance a count that misses the calls
 * most worth counting.
 */
export type RefineOutcome = { usage: RefineUsage[] } & (
  | { ok: true; text: string; reason: string }
  | { ok: false; failure: RefineFailure }
);

/**
 * Everything the refine's one model call is bounded by, as a pure function.
 *
 * Exported and separated from the call for `probeCallArgs`' reason: these are
 * the decisions about the call worth pinning, and neither can be observed
 * through `run` without a provider. Building the context contacts nobody.
 *
 * `maxRetries: 0` is the whole of the money argument, and it is not optional
 * to think about — `RefineContext` requires the field, so a caller that forgot
 * it does not compile. Left at the SDK's default of 2, one press buys up to
 * SIX billed round trips (three transport attempts, each of which can meet
 * `generateStructured`'s repair retry), and the hourly allowance's lock-free
 * design rests on a press costing a small bounded number of rows: at 0 a press
 * writes at most two, so a press admitted at 119 leaves the hour at most two
 * rows over. It also stops a person watching a spinner from sitting through
 * real exponential backoff before being told the provider is rate-limiting
 * them.
 *
 * It does NOT switch off the repair retry, which fires on a schema violation —
 * a refine that meets one costs two physical calls, both metered, both
 * charged, and both counted against the allowance.
 *
 * No `abortSignal`: see `REFINE_TIMEOUT_MS`.
 */
export function refineCallContext(
  model: ReturnType<typeof resolveModel>,
  provider: AiCredential["provider"],
  brand: StepBrand,
  onUsage: StepUsageSink,
): RefineContext {
  return {
    brand,
    model,
    // The credential's provider, never a guess from the model id: it decides
    // which price table this call's ledger rows are costed against.
    provider,
    onUsage,
    maxRetries: 0,
    timeoutMs: REFINE_TIMEOUT_MS,
  };
}

/**
 * The live half of a refine: turn the org's key into a model, ask it to revise
 * one selection, and report what came back and what it cost.
 *
 * A separate injectable rather than a method on `ContentRepository`, for
 * `AiCredentialProbe`'s reason and with the same payoff: it is the only piece
 * of this feature that talks to a provider, so overriding it is what lets the
 * e2e drive the whole endpoint — the guard, org scoping, the editability read,
 * the allowance, the ledger write, the staged row, the supersede — without any
 * test reaching Google or OpenRouter, which CLAUDE.md forbids outright. The
 * repository keeps every database line; this keeps every network line.
 *
 * It classifies nothing about the DRAFT and decides nothing about money: it
 * does not read the allowance, does not write the ledger, and does not know
 * what a proposal row is. It is handed a credential, a brand and three strings,
 * and it answers with a reply or a reason there is none.
 */
@Injectable()
export class RefineCaller {
  async run(args: {
    credential: AiCredential;
    brand: StepBrand;
    verb: RefineVerb;
    input: RefineInput;
  }): Promise<RefineOutcome> {
    const usage: RefineUsage[] = [];
    const sink: StepUsageSink = (record, attribution) => {
      usage.push({ record, attribution });
    };

    let output: RefineOutput;
    try {
      output = await this.call(args.credential, args.brand, args.verb, args.input, sink);
    } catch (error) {
      return { ok: false, failure: classifyRefineFailure(error), usage };
    }
    return { ok: true, text: output.text, reason: output.reason, usage };
  }

  /**
   * The ONE line in this feature that reaches a provider, and the seam every
   * test replaces — `resolveModel`, and nothing else.
   *
   * `protected` and this narrow on purpose. Everything after it is production
   * code the tests must keep exercising for real: `refineCallContext`'s two
   * bounds, `refineStep`'s prompt boundary and fence, `generateStructured`'s
   * repair retry and metering, this class's own usage collection, and the
   * failure classification below — which is the part that must never leak a
   * key and therefore has to be driven by errors a provider would actually
   * throw. A subclass overriding this returns a `MockLanguageModelV4`; a wider
   * seam would stub out the things worth testing along with the network.
   *
   * ⚠ ONE LOGICAL CALL, NOT ONE PHYSICAL ONE. `maxRetries: 0` switches off
   * transport retries only; a schema violation still costs a second, billed
   * round trip.
   */
  protected buildModel(credential: AiCredential): ReturnType<typeof resolveModel> {
    return resolveModel(credential);
  }

  private call(
    credential: AiCredential,
    brand: StepBrand,
    verb: RefineVerb,
    input: RefineInput,
    onUsage: StepUsageSink,
  ): Promise<RefineOutput> {
    const context = refineCallContext(
      this.buildModel(credential),
      credential.provider,
      brand,
      onUsage,
    );
    return refineStep(verb).run(context, input);
  }
}

/**
 * Which of the two failures this was.
 *
 * Off `classifyAiError`'s TAG rather than a fresh decision about the error, for
 * the reason `classifyProbeFailure` documents at length: re-deriving a mapping
 * that already exists is how `timed_out` came to be reported as
 * `rate_limited`. Everything `generateStructured` throws arrives already
 * classified and already tagged, and the tag is read rather than recomputed.
 *
 * Everything that is not a timeout is `failed`, deliberately, and the
 * coarseness is the point: the six refusals this route can answer with are the
 * ones a reader can DO something different about, and "the provider said no"
 * and "the answer would not parse" are one action — press again, and if it
 * keeps happening go and Test the key, where a real diagnosis lives.
 */
export function classifyRefineFailure(error: unknown): RefineFailure {
  return runFailureOf(classifyAiError(error)) === "timed_out" ? "timed_out" : "failed";
}
