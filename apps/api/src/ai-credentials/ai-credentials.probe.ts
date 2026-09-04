import { Injectable } from "@nestjs/common";
import {
  type AiCredential,
  classifyAiError,
  generateStructured,
  probeThinkingOptions,
  resolveModel,
  runFailureOf,
  type UsageRecord,
  type UsageSink,
} from "@pubrick/ai";
import type { AiTestFailure, RunFailure } from "@pubrick/shared";
import { z } from "zod";

/**
 * What one Test call produced.
 *
 * `records` is present on BOTH arms on purpose: a call that failed after the
 * provider counted tokens was still billed, and the ledger records money spent
 * whether or not we liked the answer.
 */
export type ProbeOutcome = {
  /** Every physical round trip the SDK made, in ledger shape. */
  records: UsageRecord[];
} & ({ ok: true; modelId: string } | { ok: false; reason: AiTestFailure });

/** The smallest thing a model can be asked to produce and still prove structured output. */
const PROBE_SCHEMA = z.object({ ok: z.literal(true) });

/**
 * The fixed prompt. Two words, and no brand or user text anywhere near it: the
 * point is to spend as close to nothing as a real call can.
 */
const PROBE_PROMPT = "Say ok";

const PROBE_INSTRUCTIONS =
  'You are a connectivity probe. Reply with the JSON value {"ok": true} and nothing else.';

/**
 * The live half of the Test action: resolve the org's key into a model and make
 * one structured call with it.
 *
 * A separate injectable rather than a method on the repository for one reason
 * that matters — it is the only piece of this feature that talks to a provider,
 * so overriding it is what lets the e2e drive the whole endpoint (guard,
 * org-scoping, decrypt, ledger write, response shape) without any test ever
 * calling Google or OpenRouter, which §8 of the generation-engine spec forbids outright. The
 * repository keeps every database line; this keeps every network line.
 */
/**
 * Everything the probe's one model call is made of except the sink.
 *
 * A pure function, exported, because these are the two things about that call
 * worth a test and neither can be observed through `run`: `maxRetries: 0` (a
 * press must not be billed three times, nor sit through real exponential
 * backoff to be told about a rate limit) and the thinking level. Building the
 * model contacts nobody, so this is free to call in a test.
 *
 * `providerOptions` asks for the least reasoning the model will accept. The
 * prompt is two words and the answer is two words; everything between them is
 * thinking the model does by default and bills at the OUTPUT rate, which is
 * most of what a press of this button costs — a connectivity check, not a
 * reasoning task. `probeThinkingOptions` returns `undefined` for any model id
 * the org typed itself, and then the key is ABSENT rather than undefined: a
 * thinking knob a model does not support is a 400, and a 400 on this button
 * reads to the user as "your key was rejected". See its own doc.
 */
export function probeCallArgs(credential: AiCredential) {
  const model = resolveModel(credential);
  const thinking = probeThinkingOptions(credential.provider, model.modelId);
  return {
    model,
    provider: credential.provider,
    schema: PROBE_SCHEMA,
    instructions: PROBE_INSTRUCTIONS,
    prompt: PROBE_PROMPT,
    maxRetries: 0,
    ...(thinking === undefined ? {} : { providerOptions: thinking }),
  };
}

@Injectable()
export class AiCredentialProbe {
  async run(credential: AiCredential): Promise<ProbeOutcome> {
    const records: UsageRecord[] = [];

    let requestedModelId: string;
    try {
      requestedModelId = await this.call(credential, (record) => {
        records.push(record);
      });
    } catch (error) {
      return { ok: false, reason: classifyProbeFailure(error, records), records };
    }

    // Which model actually answered: the id telemetry reported for the round
    // trip, falling back to the one we asked for. They differ on OpenRouter,
    // where the catalogue id can route elsewhere — and "which model answered"
    // is half of what this button is for.
    return { ok: true, modelId: records[0]?.modelId ?? requestedModelId, records };
  }

  /**
   * The only lines in this feature that reach a provider — and the seam every
   * test replaces.
   *
   * `protected`, not private: `run`'s failure classification is the part that
   * must never leak a key, so it has to be exercised for real. A test subclass
   * overrides this one method and throws the error a provider would, leaving
   * the classification under test rather than stubbed out with it.
   *
   * Returns the model id we asked for, so `run` has a fallback when telemetry
   * reports none.
   *
   * ⚠ This is *one logical call*, not necessarily one physical one.
   * `maxRetries: 0` switches off the SDK's transport retries — the button's
   * promise is a minimal call, and a BYOK user should not be billed three times
   * for one click, nor sit through real exponential backoff to be told about a
   * rate limit. It does NOT switch off `generateStructured`'s repair retry,
   * which fires on exactly the schema violation this button exists to provoke:
   * a Test that meets one costs two physical calls, both metered, both charged.
   *
   * What it asks for, apart from the sink, is `probeCallArgs` — a pure function
   * so that the two decisions worth pinning (no transport retries, and the
   * cheapest thinking the model will accept) can be asserted without a network.
   */
  protected async call(credential: AiCredential, onUsage: UsageSink): Promise<string> {
    const args = probeCallArgs(credential);
    await generateStructured({ ...args, onUsage });
    return args.model.modelId;
  }
}

/**
 * The Test verdict for every run-failure code, or `null` where this button
 * cannot say the true thing and something else must decide.
 *
 * TOTAL over `RunFailure` on purpose, and that totality is the whole point: a
 * code added to `RUN_FAILURES` is a compile error here rather than a silent
 * fall-through to a neighbour. The previous shape — this function re-deriving
 * the SAME status→code mapping `classifyAiError` had already made — is exactly
 * how `timed_out` came to be reported as `rate_limited`: one copy of a mapping
 * grew an arm and the other did not, and nothing failed.
 *
 * The `null`s are decisions, not omissions:
 * - `cancelled` — nothing cancels a probe; no signal is passed to it.
 * - `every_channel_deleted`, `retries_exhausted`, `too_long_for_channel` — a
 *   run's failures, reachable only from the worker's pipeline.
 * - `no_api_key` — a stored key that decrypts to nothing. `AI_TEST_FAILURES`
 *   has no member for it and inventing one would be a member no screen can
 *   reach: the upsert schema requires eight characters and the controller 404s
 *   when there is no row at all.
 * - `internal` — the honest "we do not know", which is precisely when the
 *   meter, below, knows more than the code does.
 */
const TEST_FAILURE_FOR_RUN_FAILURE: Record<RunFailure, AiTestFailure | null> = {
  cancelled: null,
  every_channel_deleted: null,
  internal: null,
  invalid_key: "invalid_key",
  model_not_found: "model_not_found",
  no_api_key: null,
  no_structured_output: "no_structured_output",
  provider_refused: "refused",
  rate_limited: "rate_limited",
  retries_exhausted: null,
  timed_out: "timed_out",
  too_long_for_channel: null,
  unreadable_key: "unreadable_key",
};

/**
 * Turn a failure into one of a closed set of codes.
 *
 * The provider's own words are deliberately dropped on the floor. They are the
 * most informative thing available and they are also where the key lives:
 * OpenAI-style bodies quote the submitted credential back
 * ("Incorrect API key provided: sk-…"), and a Google quota error quotes the
 * request URL, which carries `?key=`. This value is handed to a browser, so the
 * only safe contract is one that cannot express a secret at all. The web app
 * turns the code into a sentence, in four languages — which the provider's
 * English could never do either.
 *
 * Three sources, in falling order of how much each one knows:
 *
 * 1. THE TAG. `classifyAiError` already decided what this error is, and every
 *    error the probe's own call path can throw carries that decision. Reading
 *    it is what keeps the two closed sets in step; re-deciding it here is what
 *    let them drift apart.
 * 2. THE STATUS. Its domain is an error that arrived already classified but
 *    NOT tagged — a `PermanentError` built by something other than
 *    `classifyAiError`, which that function returns untouched. Narrow, and kept
 *    because the alternative is calling a 401 a refusal.
 * 3. THE METER. `internal` means we could not attribute the failure; the token
 *    counts still can. If any round trip reported tokens the provider DID
 *    answer, so what failed was the answer's SHAPE — precisely the thing this
 *    button exists to detect. Never error prose: a model can write prose.
 *
 * `.name` rather than `instanceof`: the marker survives duplicate copies of
 * `@pubrick/shared` in the tree, which is the same reason the SDK's own
 * `APICallError.isInstance` exists.
 */
export function classifyProbeFailure(
  error: unknown,
  records: readonly UsageRecord[],
): AiTestFailure {
  const classified = classifyAiError(error);

  const tagged = runFailureOf(classified);
  if (tagged !== undefined) {
    const mapped = TEST_FAILURE_FOR_RUN_FAILURE[tagged];
    if (mapped !== null) return mapped;
  } else {
    // Untagged. `TransientError` has no status to read, and the only transient
    // this function can be handed without a tag is a retryable provider error.
    if (classified.name === "TransientError") return "rate_limited";

    const status = (classified as { code?: number }).code;
    if (status === 401 || status === 403) return "invalid_key";
    if (status === 404) return "model_not_found";
    if (status !== undefined) return "refused";
  }

  const providerAnswered = records.some((record) => record.inputTokens + record.outputTokens > 0);
  return providerAnswered ? "no_structured_output" : "refused";
}
