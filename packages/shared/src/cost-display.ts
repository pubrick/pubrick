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
 *   UNPRICED  not priced, AND either the provider counted tokens
 *             (input + output > 0) OR the row's outcome is `unknown`. Money was
 *             spent, or may have been, and nothing can name the amount — so the
 *             total is a floor.
 *   IGNORED   not priced, no tokens, and the outcome is not `unknown`. A round
 *             trip the provider REFUSED before generating anything — a 429, a
 *             401. Its cost is KNOWN, and it is zero: it neither adds to the sum
 *             nor degrades the label.
 *
 * That last bucket is the refinement §4 gained once metering moved to every
 * physical round trip: failed attempts write rows too, and the ledger is
 * lifetime, so a rule that called every null-cost row "unpriced" would let one
 * transient blip stamp "≥ $X (1 unpriced)" on an org's total forever.
 *
 * THE OUTCOME CLAUSE IS THE OTHER HALF OF THAT, and it was missing until
 * 2026-09-02. A zero-token row is written by a 429 AND by every failure after
 * dispatch — a timeout, a socket reset, a 200 whose body would not parse, an
 * abort — and the second kind may have been billed in full: Google bills a
 * completed generation whether or not the client received it. Filed under
 * IGNORED they neither added to the sum nor raised the "≥", so the figure
 * shrank AND kept the symbol that means "estimate". Measured: one priced call
 * plus three timed-out ones rendered "≈ $0.007875" against a true $0.0315.
 * `usage_ledger.outcome` is what tells the two apart; NULL (a row written
 * before that column) reads as `completed`, which is the meaning it already had.
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

/**
 * Where a ledger row's dollar figure came from — `usage_ledger.cost_source`.
 *
 * THE declaration, not a mirror of one. `@pubrick/db` types the column with it
 * and builds the column's CHECK constraint from it; `@pubrick/ai` decides which
 * member each call gets; the rules above read it. It used to be written out in
 * all three, held together by a pin test in a fourth package.
 */
export const AI_COST_SOURCES = ["provider_reported", "price_table", "unknown"] as const;
export type AiCostSource = (typeof AI_COST_SOURCES)[number];

/**
 * What became of the round trip a row records — `usage_ledger.outcome`, and
 * the one declaration of it.
 *
 * `refused` is a verdict the provider delivered instead of a generation, so it
 * is genuinely free. `unknown` is a request that left and never came back, so
 * it may be a full charge. `completed` is a round trip that returned — whether
 * the ANSWER was usable is `cost_source`'s business, not this column's.
 */
export const AI_CALL_OUTCOMES = ["completed", "refused", "unknown"] as const;
export type AiCallOutcome = (typeof AI_CALL_OUTCOMES)[number];

/**
 * How the ATTEMPT ended — `usage_ledger.status`. A row exists even when the
 * call failed after the provider had counted tokens, which is why this and
 * `AI_CALL_OUTCOMES` are two columns rather than one: the attempt can fail on
 * the schema while the provider's side of the round trip completed and billed.
 *
 * Beside the cost vocabulary because it IS the ledger row's vocabulary, and
 * because the alternative is where it was: hand-typed as a union in
 * `@pubrick/ai` and as an array in `@pubrick/db`, with nothing comparing them.
 */
export const LEDGER_STATUSES = ["ok", "errored"] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

/**
 * Whose key paid for the call — `usage_ledger.key_ownership`. Always `byok`
 * today; the column exists so the later platform-key quota queries need no
 * migration.
 */
export const KEY_OWNERSHIPS = ["byok", "platform"] as const;
export type KeyOwnership = (typeof KEY_OWNERSHIPS)[number];

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
 * Neither the token counts nor `outcome` is decoration. Together they separate
 * "the model answered and we cannot price it" and "we never learned what the
 * provider did" — both real money — from "the provider refused before
 * generating anything", which is the only one that is free.
 */
export type CostRow = {
  costUsd: number | null;
  costSource: AiCostSource;
  inputTokens: number;
  outputTokens: number;
  /**
   * NULL for a row written before the column existed, and read as `completed`.
   * Required rather than optional so a new producer of these rows has to decide
   * — the whole defect this closed was a writer that had no way to say
   * "unknown" and a reader that therefore never heard it.
   */
  outcome: AiCallOutcome | null;
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
    // Either half is enough. Tokens mean the provider metered work; `unknown`
    // means we cannot say it did not.
    if (row.inputTokens + row.outputTokens > 0 || row.outcome === "unknown") unpricedCalls += 1;
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
