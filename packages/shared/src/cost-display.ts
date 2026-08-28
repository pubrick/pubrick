/**
 * How a pile of ledger rows becomes one honest figure.
 *
 * `usage_ledger.cost_usd` is nullable on purpose: OpenRouter's cost field is
 * optional and the local price table has a long tail, so "we do not know what
 * this call cost" is a real, frequent outcome. `SUM()` over that column skips
 * the nulls silently, which means the naive query renders a confident, precise,
 * WRONG number — smaller than the truth, with nothing on screen to say so.
 *
 * The three rules below are the whole fix, and they are exact:
 *
 *  1. any `unknown` row              → `>= $X`, with the count of unpriced calls
 *  2. any `price_table` row, none unknown → `~ $X`
 *  3. all `provider_reported`        → `$X`
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

/**
 * The aggregate the rules are decided from.
 *
 * `usd` is `SUM(cost_usd)` — the rows it could not price contributed nothing to
 * it, which is precisely why they are counted separately rather than trusted to
 * the sum.
 */
export type LedgerCostTotals = {
  usd: number;
  /** Rows whose cost is not known: `cost_source = 'unknown'`, or a null cost. */
  unpricedCalls: number;
  /** Rows priced from our own table rather than reported by the provider. */
  estimatedCalls: number;
};

/** One ledger row, in the shape both the SQL aggregate and a `UsageRecord` share. */
export type CostRow = { costUsd: number | null; costSource: AiCostSource };

/**
 * Fold rows into totals.
 *
 * A null `costUsd` counts as unpriced whatever `costSource` claims. The two
 * cannot disagree by construction, and if a future writer makes them disagree
 * the honest reading is the one that under-claims knowledge, not the one that
 * quietly drops a call out of the total.
 */
export function costTotals(rows: readonly CostRow[]): LedgerCostTotals {
  let usd = 0;
  let unpricedCalls = 0;
  let estimatedCalls = 0;
  for (const row of rows) {
    if (row.costUsd === null || row.costSource === "unknown") {
      unpricedCalls += 1;
      continue;
    }
    usd += row.costUsd;
    if (row.costSource === "price_table") estimatedCalls += 1;
  }
  return { usd, unpricedCalls, estimatedCalls };
}

/** The three rules, in order. */
export function summarizeCost(totals: LedgerCostTotals): CostSummary {
  const usd = Number.isFinite(totals.usd) ? Math.max(totals.usd, 0) : 0;
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
  const value = Number.isFinite(usd) ? Math.max(usd, 0) : 0;
  if (value === 0) return "$0.00";
  if (value >= 0.01) return `$${value.toFixed(2)}`;
  const trimmed = value.toFixed(6).replace(/0+$/, "");
  // Something positive, but smaller than six decimals can show — impossible from
  // the ledger (`estimateCostUsd` floors a non-zero cost at 0.000001, and the
  // column stores nothing finer), so this is defensive. Floor it at the smallest
  // expressible unit rather than emitting the broken string "$0." or claiming
  // the call was free.
  return trimmed.endsWith(".") ? "$0.000001" : `$${trimmed}`;
}
