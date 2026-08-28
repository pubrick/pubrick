import { Injectable } from "@nestjs/common";
import {
  type AiCredential,
  classifyAiError,
  generateStructured,
  resolveModel,
  type UsageRecord,
} from "@pubrick/ai";
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
} & ({ ok: true; modelId: string } | { ok: false; reason: string });

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

    let model: ReturnType<typeof resolveModel>;
    try {
      model = resolveModel(credential);
    } catch (error) {
      // An empty stored key, or a provider the factory does not build. No call
      // was made, so there is nothing to meter.
      return { ok: false, reason: reasonFor(error), records };
    }

    try {
      await generateStructured({
        model,
        provider: credential.provider,
        schema: PROBE_SCHEMA,
        instructions: PROBE_INSTRUCTIONS,
        prompt: PROBE_PROMPT,
        onUsage: (record) => {
          records.push(record);
        },
        // ONE physical call, deliberately. The SDK's default of 2 retries would
        // bill a BYOK user up to three times for a button whose entire promise
        // is "one minimal call", and a rate limit or a 5xx is a result worth
        // showing the user now rather than after two rounds of real backoff.
        maxRetries: 0,
      });
    } catch (error) {
      return { ok: false, reason: reasonFor(error), records };
    }

    // Which model actually answered: the id telemetry reported for the round
    // trip, falling back to the one we asked for. They differ on OpenRouter,
    // where the catalogue id can route elsewhere — and "which model answered"
    // is half of what this button is for.
    return { ok: true, modelId: records[0]?.modelId ?? model.modelId, records };
  }
}

/**
 * A sentence for the user.
 *
 * `classifyAiError` is idempotent — `generateStructured` has usually classified
 * already — and it keeps the provider's own words ("API key not valid"), which
 * for a Test action is the single most useful thing on screen. A rejected key
 * is a *result*, not a 500: the endpoint answers 200 with this reason, exactly
 * as the channel verify endpoint does.
 */
function reasonFor(error: unknown): string {
  return classifyAiError(error).message;
}
