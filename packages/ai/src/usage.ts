import { estimateCostUsd, priceFor } from "./pricing.js";
import type { AiProvider } from "./provider.js";

/** Where a ledger row's dollar figure came from. Mirrors `COST_SOURCES` in `@pubrick/db`. */
export type CostSource = "provider_reported" | "price_table" | "unknown";

/** A row exists even when the call failed after the provider had counted tokens. */
export type UsageStatus = "ok" | "errored";

/**
 * One **physical** round trip to the provider, in the shape the ledger stores it.
 *
 * `provider` is the credential's provider, not a string parsed out of an SDK id:
 * the ledger column is an enum, and we always know which key paid for the call.
 * `attempt` is 2 for a structured-output repair retry of the same step; the
 * caller adds `orgId`, `runId`, `step` and `channelId`, which this package has
 * no way to know.
 */
export type UsageRecord = {
  provider: AiProvider;
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
 * What `executeLanguageModelCall`'s `execute()` resolves to: the raw
 * provider-level result.
 *
 * ⚠ This carries the **nested** usage shape — `inputTokens.total`,
 * `inputTokens.cacheRead`, `outputTokens.reasoning`. The *other* shape, flat
 * totals with nested details (`inputTokens`, `inputTokenDetails.cacheReadTokens`),
 * is what the `onLanguageModelCallEnd` event carries. Choosing the metering hook
 * chooses the shape, and reading the wrong one yields silent zeros rather than an
 * error. Both appear in the tests on purpose.
 */
export type ProviderCallResult = {
  usage?: {
    inputTokens?: { total?: number | undefined; cacheRead?: number | undefined };
    outputTokens?: { total?: number | undefined; reasoning?: number | undefined };
  };
  providerMetadata?: Record<string, unknown> | undefined;
};

/** One physical round trip, buffered until the attempt's outcome is known. */
export type MeteredCall = {
  modelId: string;
  responseMs: number;
  /** Absent when the round trip threw: the provider reported no tokens at all. */
  result?: ProviderCallResult;
  /** False when the round trip itself failed, whatever the attempt went on to do. */
  transportOk: boolean;
};

/**
 * OpenRouter reports what the call actually cost. The field is **optional** —
 * its absence is normal and must never be read as zero, because a zero would
 * be summed into a total that looks authoritative and is wrong.
 *
 * A reported `0` is different: that is a report, and free models really do
 * cost nothing. A *negative* figure is neither — no call earns money — so it is
 * treated as no report at all rather than quietly credited against the run.
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
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return null;
  return cost;
}

/** Turn one physical call into the ledger row it implies. */
export function toUsageRecord(
  call: MeteredCall,
  options: { provider: AiProvider; attempt: number; status: UsageStatus; at: Date },
): UsageRecord {
  const usage = call.result?.usage;
  const inputTotal = usage?.inputTokens?.total;
  const outputTotal = usage?.outputTokens?.total;

  // A call the provider never reported tokens for — it threw, or the provider
  // omitted usage — cannot be priced from a table that multiplies token counts.
  // Pricing it as zero would render "≈ $0.00", a precise-looking claim that the
  // call was free. Unknown is the honest answer.
  const hasUsage = typeof inputTotal === "number" || typeof outputTotal === "number";
  const inputTokens = inputTotal ?? 0;
  const outputTokens = outputTotal ?? 0;

  const reported = providerReportedCostUsd(call.result?.providerMetadata);
  const rate =
    reported === null && hasUsage ? priceFor(options.provider, call.modelId, options.at) : null;

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
    provider: options.provider,
    modelId: call.modelId,
    attempt: options.attempt,
    inputTokens,
    outputTokens,
    cachedInputTokens: usage?.inputTokens?.cacheRead ?? 0,
    reasoningTokens: usage?.outputTokens?.reasoning ?? 0,
    costUsd,
    costSource,
    responseMs: Math.round(call.responseMs),
    status: options.status,
  };
}

/**
 * A telemetry integration that buffers every **physical** model call of a single
 * `generateText`, so each one's status can be decided once the attempt settles.
 *
 * The hook is `executeLanguageModelCall`, which the SDK invokes *inside* its own
 * retry closure — once per round trip. `onLanguageModelCallEnd`, the obvious
 * choice, fires after the retry loop has resolved: once per step, or not at all
 * if every attempt failed. Metering there bills a BYOK user for retries that
 * leave no record, which is precisely what the ledger exists to prevent.
 *
 * It is built per call and passed as `telemetry: { integrations: recorder }`,
 * never through `registerTelemetry`: the global registry has no unregister, so
 * a sink registered in one test file would still be listening in the next.
 * Per-call integrations take precedence over the global list.
 */
export function createCallRecorder(fallbackModelId: string): {
  integration: {
    executeLanguageModelCall: <T>(options: {
      modelId?: string | undefined;
      execute: () => PromiseLike<T>;
    }) => Promise<T>;
  };
  calls: MeteredCall[];
} {
  const calls: MeteredCall[] = [];

  return {
    calls,
    integration: {
      executeLanguageModelCall: async <T>(options: {
        modelId?: string | undefined;
        execute: () => PromiseLike<T>;
      }): Promise<T> => {
        const startedAt = Date.now();
        const modelId = options.modelId ?? fallbackModelId;
        try {
          const result = await options.execute();
          calls.push({
            modelId,
            responseMs: Date.now() - startedAt,
            // The SDK types `execute()` generically; at this call site it always
            // resolves to the provider's own generate result. The runtime shape
            // is pinned by the tests rather than by this cast.
            result: result as ProviderCallResult,
            transportOk: true,
          });
          return result;
        } catch (error) {
          calls.push({ modelId, responseMs: Date.now() - startedAt, transportOk: false });
          throw error;
        }
      },
    },
  };
}
