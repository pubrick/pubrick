import { Injectable } from "@nestjs/common";
import {
  type AiCredential,
  classifyAiError,
  generateStructured,
  resolveModel,
  type UsageRecord,
  type UsageSink,
} from "@pubrick/ai";
import type { AiTestFailure } from "@pubrick/shared";
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
 * calling Google or OpenRouter, which §8 of the design forbids outright. The
 * repository keeps every database line; this keeps every network line.
 */
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
   */
  protected async call(credential: AiCredential, onUsage: UsageSink): Promise<string> {
    const model = resolveModel(credential);
    await generateStructured({
      model,
      provider: credential.provider,
      schema: PROBE_SCHEMA,
      instructions: PROBE_INSTRUCTIONS,
      prompt: PROBE_PROMPT,
      onUsage,
      maxRetries: 0,
    });
    return model.modelId;
  }
}

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
 * `.name` rather than `instanceof`: the marker survives duplicate copies of
 * `@pubrick/shared` in the tree, which is the same reason the SDK's own
 * `APICallError.isInstance` exists.
 */
export function classifyProbeFailure(
  error: unknown,
  records: readonly UsageRecord[],
): AiTestFailure {
  const classified = classifyAiError(error);
  if (classified.name === "TransientError") return "rate_limited";

  const status = (classified as { code?: number }).code;
  if (status === 401 || status === 403) return "invalid_key";
  if (status === 404) return "model_not_found";
  if (status !== undefined) return "refused";

  // No HTTP status at all: the throw came from our own structured-output layer
  // (a schema violation twice over, or a tool call where text was required)
  // rather than from the transport. Distinguished by the meter, never by error
  // prose: if any round trip reported tokens the provider DID answer, so what
  // failed was the answer's shape — which is precisely the thing this button
  // exists to detect. No tokens means nothing ever got that far.
  const providerAnswered = records.some((record) => record.inputTokens + record.outputTokens > 0);
  return providerAnswered ? "no_structured_output" : "refused";
}
