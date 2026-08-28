import { estimateCostUsd, priceFor } from "./pricing.js";

/** Where a ledger row's dollar figure came from. Mirrors `COST_SOURCES` in `@pubrick/db`. */
export type CostSource = "provider_reported" | "price_table" | "unknown";

/** A row exists even when the call failed after the provider had counted tokens. */
export type UsageStatus = "ok" | "errored";

/**
 * One model call, in the shape the ledger stores it.
 *
 * `attempt` is 2 for a structured-output repair retry of the same step; the
 * caller adds `orgId`, `runId`, `step` and `channelId`, which this package has
 * no way to know.
 */
export type UsageRecord = {
  provider: string;
  modelId: string;
  attempt: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  /** Kept because Gemini 3.x bills thinking tokens at the output rate. */
  reasoningTokens: number;
  costUsd: number | null;
  costSource: CostSource;
  responseMs: number;
  status: UsageStatus;
};

export type UsageSink = (record: UsageRecord) => Promise<void> | void;

/**
 * The subset of the SDK's `LanguageModelCallEndEvent` this package reads.
 *
 * Declared structurally rather than imported so the mapping is pinned to the
 * fields we actually depend on. Note the shape: **flat totals with nested
 * details**. The fully nested provider-level shape — `inputTokens.total`,
 * `inputTokens.cacheRead` — is what `MockLanguageModelV4.doGenerate` returns
 * and what model middleware sees; it never reaches here. Mixing the two is the
 * easiest mistake in this file, so both appear in the tests on purpose.
 */
export type ModelCallEnd = {
  provider: string;
  modelId: string;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    inputTokenDetails?: { cacheReadTokens?: number };
    outputTokenDetails?: { reasoningTokens?: number };
  };
  providerMetadata?: Record<string, unknown> | undefined;
  performance?: { responseTimeMs?: number };
};

/**
 * `google.generative-ai` → `google`, `openrouter` → `openrouter`.
 *
 * The SDK reports its own provider ids; the price table and the ledger's
 * provider column speak our two-value vocabulary. Anything unrecognised passes
 * through unchanged rather than being coerced, so an unexpected id shows up in
 * the ledger as itself instead of masquerading as a provider we support.
 */
export function normalizeProviderName(providerId: string): string {
  const head = providerId.split(".")[0];
  return head === undefined || head === "" ? providerId : head;
}

/**
 * OpenRouter reports what the call actually cost. The field is **optional** —
 * its absence is normal and must never be read as zero, because a zero would
 * be summed into a total that looks authoritative and is wrong.
 *
 * A reported `0` is different: that is a report, and free models really do
 * cost nothing.
 *
 * (Two neighbours that will surprise anyone grepping: the sibling field is
 * camelCased — `costDetails.upstreamInferenceCost` — and video models report
 * cost one level up. Neither is used here.)
 */
export function providerReportedCostUsd(
  providerMetadata: Record<string, unknown> | undefined,
): number | null {
  const openrouter = providerMetadata?.openrouter as { usage?: { cost?: unknown } } | undefined;
  const cost = openrouter?.usage?.cost;
  return typeof cost === "number" && Number.isFinite(cost) ? cost : null;
}

/** Turn one telemetry event into the ledger row it implies. */
export function toUsageRecord(
  event: ModelCallEnd,
  options: { attempt: number; status: UsageStatus; at: Date },
): UsageRecord {
  const provider = normalizeProviderName(event.provider);
  const inputTokens = event.usage.inputTokens ?? 0;
  const outputTokens = event.usage.outputTokens ?? 0;

  const reported = providerReportedCostUsd(event.providerMetadata);
  const rate = reported === null ? priceFor(provider, event.modelId, options.at) : null;

  let costUsd: number | null;
  let costSource: CostSource;
  if (reported !== null) {
    costUsd = reported;
    costSource = "provider_reported";
  } else if (rate !== null) {
    costUsd = estimateCostUsd(rate, { inputTokens, outputTokens });
    costSource = "price_table";
  } else {
    costUsd = null;
    costSource = "unknown";
  }

  return {
    provider,
    modelId: event.modelId,
    attempt: options.attempt,
    inputTokens,
    outputTokens,
    cachedInputTokens: event.usage.inputTokenDetails?.cacheReadTokens ?? 0,
    reasoningTokens: event.usage.outputTokenDetails?.reasoningTokens ?? 0,
    costUsd,
    costSource,
    responseMs: Math.round(event.performance?.responseTimeMs ?? 0),
    status: options.status,
  };
}

/**
 * A telemetry integration that buffers the model calls of a single
 * `generateText`, so their status can be decided once the call has settled.
 *
 * It is built per call and passed as `telemetry: { integrations: recorder }`,
 * never through `registerTelemetry`: the global registry has no unregister, so
 * a sink registered in one test file would still be listening in the next.
 * Per-call integrations take precedence over the global list.
 */
export function createCallRecorder(): {
  integration: { onLanguageModelCallEnd: (event: ModelCallEnd) => void };
  events: ModelCallEnd[];
} {
  const events: ModelCallEnd[] = [];
  return {
    integration: {
      onLanguageModelCallEnd: (event: ModelCallEnd) => {
        events.push(event);
      },
    },
    events,
  };
}
