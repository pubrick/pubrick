/**
 * Local price table.
 *
 * Rates are stored with an effective date rather than as bare numbers because
 * Gemini 3.x Flash is on an explicitly introductory price that doubles on
 * 2027-01-01. Storing the future rate now makes that change data, not a code
 * change made in a hurry on a January morning.
 *
 * A model the table does not know returns `null`, and the caller records the
 * ledger row with `cost_source: "unknown"` and `cost_usd: null`. That is a real
 * outcome — OpenRouter's catalogue has a long tail and Google adds models — and
 * it is why the ledger column is nullable: a missing cost summed as zero renders
 * a confident, wrong number.
 */

/** Dollars per million tokens. */
export type ModelRate = {
  inputPerMTok: number;
  outputPerMTok: number;
};

type RateWindow = ModelRate & {
  /** ISO date. The window applies from this instant until the next window starts. */
  effectiveFrom: string;
};

/**
 * The Gemini Flash tier. $0.75 / $3.75 per 1M is introductory as of 2026-08-28
 * and doubles on 2027-01-01, per Google's own pricing page.
 */
const GEMINI_FLASH_TIER: RateWindow[] = [
  { effectiveFrom: "1970-01-01", inputPerMTok: 0.75, outputPerMTok: 3.75 },
  { effectiveFrom: "2027-01-01", inputPerMTok: 1.5, outputPerMTok: 7.5 },
];

/**
 * Keyed by our canonical provider name (see `normalizeProviderName`), then by
 * model id.
 *
 * `openrouter` is deliberately empty: OpenRouter reports the real cost of every
 * call in `providerMetadata.openrouter.usage.cost`, so a hardcoded table for it
 * would be a second, staler source of truth for a number we are already told.
 * When that optional field is absent the honest answer is `unknown`.
 */
const PRICE_TABLE: Record<string, Record<string, RateWindow[]>> = {
  google: {
    "gemini-3.7-flash": GEMINI_FLASH_TIER,
  },
  openrouter: {},
};

/**
 * The rates in force for `modelId` at `at`, or `null` if the table has never
 * heard of the model.
 */
export function priceFor(provider: string, modelId: string, at: Date): ModelRate | null {
  const windows = PRICE_TABLE[provider]?.[modelId];
  if (windows === undefined) return null;

  // The latest window that has already started — picked by date, not by array
  // position, so a rate appended out of order cannot silently misprice a call.
  let current: RateWindow | null = null;
  let currentStart = Number.NEGATIVE_INFINITY;
  for (const window of windows) {
    const start = Date.parse(window.effectiveFrom);
    if (start <= at.getTime() && start >= currentStart) {
      current = window;
      currentStart = start;
    }
  }
  if (current === null) return null;

  // Returned without `effectiveFrom`: callers compare rates, not provenance.
  return { inputPerMTok: current.inputPerMTok, outputPerMTok: current.outputPerMTok };
}

/**
 * Cost of one call from the price table, in dollars.
 *
 * `outputTokens` already includes reasoning tokens (the SDK's flat total is the
 * sum of its `outputTokenDetails`), and on Gemini 3.x thinking bills at the
 * output rate — so reasoning needs no separate term here. Cached input is
 * charged at the full input rate: the discount is real but unverified, and an
 * estimate that is slightly high is safer in a column the UI prefixes with "≈"
 * than one that is silently low.
 */
export function estimateCostUsd(
  rate: ModelRate,
  tokens: { inputTokens: number; outputTokens: number },
): number {
  const dollars =
    (tokens.inputTokens * rate.inputPerMTok + tokens.outputTokens * rate.outputPerMTok) / 1_000_000;
  // The ledger column is numeric(12,6); rounding here keeps the stored value and
  // the value we just computed identical.
  const rounded = Math.round(dollars * 1_000_000) / 1_000_000;

  // A call that cost something must never store 0.000000. The column cannot hold
  // the true figure, and the UI renders a `price_table` row as a definite "≈ $0.00"
  // — a call that was billed reported as free. The smallest unit the column can
  // express is the honest floor.
  if (dollars > 0 && rounded === 0) return 0.000001;
  return rounded;
}
