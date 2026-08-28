/**
 * How a pile of ledger rows becomes one honest figure.
 *
 * `usage_ledger.cost_usd` is nullable on purpose: OpenRouter's cost field is
 * optional and the local price table has a long tail, so "we do not know what
 * this call cost" is a real, frequent outcome. `SUM()` over that column skips
 * the nulls silently, which means the naive query renders a confident, precise,
 * WRONG number — smaller than the truth, with nothing on screen to say so.
 *
 * Every row falls in exactly one of three buckets, and BOTH readers of the
 * ledger — this function and the SQL aggregate in `AiCredentialsRepository.spend`
 * — implement these three, identically. Two code paths answering one question is
 * how a total starts depending on which screen asked:
 *
 *   PRICED    `cost_usd IS NOT NULL AND cost_source <> 'unknown'`
 *             The only rows that add to the sum. `price_table` ones make it an
 *             estimate.
 *   UNPRICED  not priced, AND the provider counted tokens (input + output > 0).
 *             Real money was spent that nothing can name, so the total is a floor.
 *   IGNORED   not priced, no tokens. A round trip the provider rejected before
 *             counting anything — a 429, a connection reset. Its cost is KNOWN,
 *             and it is zero: it neither adds to the sum nor degrades the label.
 *
 * That last bucket is the refinement §4 gained once metering moved to every
 * physical round trip: failed attempts write rows too, and the ledger is
 * lifetime, so a rule that called every null-cost row "unpriced" would let one
 * transient blip stamp "≥ $X (1 unpriced)" on an org's total forever.
 *
 * The display rules are then exactly three:
 *
 *  1. any unpriced row                    → `>= $X`, with the unpriced count
 *  2. any estimated row, none unpriced    → `~ $X`
 *  3. everything provider-reported        → `$X`
 *
 * They apply identically to one run's cost, one Test call's cost and the org's
 * spend to date, which is why this lives in `@pubrick/shared` and not in a
 * screen: three copies of a rounding rule become three different numbers.
 */

/** Where a ledger row's dollar figure came from. Mirrors `COST_SOURCES` in `@pubrick/db`. */
export const AI_COST_SOURCES = ["provider_reported", "price_table", "unknown"] as const;
export type AiCostSource = (typeof AI_COST_SOURCES)[number];

/**
 * A total plus the provenance needed to render it truthfully.
 *
 * A discriminated union rather than `{ usd, isApproximate, isPartial }`: the
 * caller cannot forget to look at a flag, and `unpricedCalls` exists only on
 * the one variant that has something to count.
 */
export type CostSummary =
  | { kind: "exact"; usd: number }
  | { kind: "approximate"; usd: number }
  | { kind: "atLeast"; usd: number; unpricedCalls: number };

/** The aggregate the rules are decided from — the sum over PRICED rows, plus two counts. */
export type LedgerCostTotals = {
  usd: number;
  /** Rows that cost real money nobody can name. See the buckets above. */
  unpricedCalls: number;
  /** Priced rows valued from our own table rather than reported by the provider. */
  estimatedCalls: number;
};

/**
 * One ledger row, in the shape both the SQL aggregate and a `UsageRecord` share.
 *
 * The token counts are not decoration: they are what separates "the model
 * answered and we cannot price it" from "the provider hung up before counting
 * anything".
 */
export type CostRow = {
  costUsd: number | null;
  costSource: AiCostSource;
  inputTokens: number;
  outputTokens: number;
};

/** Fold rows into totals, applying the three buckets above. */
export function costTotals(rows: readonly CostRow[]): LedgerCostTotals {
  let usd = 0;
  let unpricedCalls = 0;
  let estimatedCalls = 0;
  for (const row of rows) {
    const priced = row.costUsd !== null && row.costSource !== "unknown";
    if (priced) {
      usd += row.costUsd as number;
      if (row.costSource === "price_table") estimatedCalls += 1;
      continue;
    }
    if (row.inputTokens + row.outputTokens > 0) unpricedCalls += 1;
  }
  return { usd, unpricedCalls, estimatedCalls };
}

/** The three rules, in order. */
export function summarizeCost(totals: LedgerCostTotals): CostSummary {
  // A negative total is impossible from any writer we own (`providerReportedCostUsd`
  // rejects negatives, `estimateCostUsd` cannot produce one), so if one appears it
  // is a data defect. Clamping it to zero would hide the defect and understate the
  // org's spend at the same time; it is shown as it is. Only a value that is not a
  // number at all falls back, because there is nothing truthful to print.
  const usd = Number.isFinite(totals.usd) ? totals.usd : 0;
  if (totals.unpricedCalls > 0) {
    return { kind: "atLeast", usd, unpricedCalls: totals.unpricedCalls };
  }
  if (totals.estimatedCalls > 0) return { kind: "approximate", usd };
  return { kind: "exact", usd };
}

/**
 * Dollars, at a precision that can express what a call actually cost.
 *
 * A structured Test call costs a few millionths of a dollar. `toFixed(2)` would
 * print "$0.00" for it — the same string an org that has spent nothing sees —
 * so anything under a cent is rendered at the ledger column's own precision
 * (`numeric(12,6)`) with trailing zeros trimmed. Exactly zero stays "$0.00",
 * because "$0.000000" reads like a rounding artefact rather than "nothing yet".
 */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return "$0.00";
  // A negative total means a defect upstream, and it is rendered rather than
  // swallowed: "$0.00" for it would look like an ordinary empty account.
  const sign = usd < 0 ? "-" : "";
  const value = Math.abs(usd);
  if (value === 0) return "$0.00";
  if (value >= 0.01) return `${sign}$${value.toFixed(2)}`;
  const trimmed = value.toFixed(6).replace(/0+$/, "");
  // Something positive, but smaller than six decimals can show. Floor it at the
  // smallest expressible unit rather than emitting the broken string "$0." or
  // claiming the call was free.
  return trimmed.endsWith(".") ? `${sign}$0.000001` : `${sign}$${trimmed}`;
}

/**
 * What actually goes into `numeric(12,6)`.
 *
 * Two traps this closes. `String(cost)` would hand Postgres whatever JavaScript
 * felt like printing (`"1e-7"`, `"0.30000000000000004"`), so the stored value and
 * the value we just computed need not agree. And a real cost smaller than a
 * millionth of a dollar would round to `0.000000` — reported as free by a column
 * the UI trusts. `estimateCostUsd` already floors the price-table path for
 * exactly this reason, but OpenRouter, the ONLY provider that reports its own
 * cost, never passes through that function: without the same floor here, one
 * call reads "$0.000001" on the Test line and "$0.00" in the org's total.
 *
 * A non-finite figure is stored as NULL — unknown, which is true — rather than
 * poisoning every later `SUM()` with `NaN`.
 */
export function toLedgerCostUsd(usd: number | null): string | null {
  if (usd === null || !Number.isFinite(usd)) return null;
  const rounded = Math.round(usd * 1_000_000) / 1_000_000;
  if (usd > 0 && rounded === 0) return (0.000001).toFixed(6);
  return rounded.toFixed(6);
}
