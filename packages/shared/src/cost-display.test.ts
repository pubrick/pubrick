import { describe, expect, it } from "vitest";
import {
  type CostRow,
  costTotals,
  formatUsd,
  summarizeCost,
  toLedgerCostUsd,
} from "./cost-display.js";

const reported = (usd: number): CostRow => ({
  costUsd: usd,
  costSource: "provider_reported",
  inputTokens: 12,
  outputTokens: 3,
});
const estimated = (usd: number): CostRow => ({
  costUsd: usd,
  costSource: "price_table",
  inputTokens: 12,
  outputTokens: 3,
});
/** A model that answered, at a price nothing could name. Real money, unknown amount. */
const unpriced = (): CostRow => ({
  costUsd: null,
  costSource: "unknown",
  inputTokens: 12,
  outputTokens: 3,
});
/** A 429 or a connection reset: rejected before the provider counted anything. */
const rejectedBeforeTokens = (): CostRow => ({
  costUsd: null,
  costSource: "unknown",
  inputTokens: 0,
  outputTokens: 0,
});

/**
 * The three rules of §4, one test each, named after the rule they defend.
 *
 * They are the whole reason the ledger's cost column is nullable, so they are
 * tested as a pure function rather than only through whichever screen happens
 * to render them.
 */
describe("the three cost display rules", () => {
  it("rule 1: any unknown row makes the total a floor — >= $X, plus the unpriced call count", () => {
    const summary = summarizeCost(costTotals([reported(0.002), estimated(0.001), unpriced()]));

    expect(summary).toEqual({ kind: "atLeast", usd: 0.003, unpricedCalls: 1 });
  });

  it("rule 2: a price_table row with no unknown row makes the total approximate — ~ $X", () => {
    const summary = summarizeCost(costTotals([reported(0.002), estimated(0.001)]));

    expect(summary).toEqual({ kind: "approximate", usd: 0.003 });
  });

  it("rule 3: rows that are all provider_reported make the total exact — $X", () => {
    const summary = summarizeCost(costTotals([reported(0.002), reported(0.001)]));

    expect(summary).toEqual({ kind: "exact", usd: 0.003 });
  });

  it("ranks unknown above price_table: one unpriced row among estimates is still a floor", () => {
    const summary = summarizeCost(costTotals([estimated(0.001), unpriced(), estimated(0.002)]));

    expect(summary.kind).toBe("atLeast");
  });

  it("counts every unpriced row, so the caller can say how many calls are missing", () => {
    const summary = summarizeCost(costTotals([unpriced(), unpriced(), reported(0.5)]));

    expect(summary).toEqual({ kind: "atLeast", usd: 0.5, unpricedCalls: 2 });
  });

  it("an org that has spent nothing is exactly $0, not approximately anything", () => {
    expect(summarizeCost(costTotals([]))).toEqual({ kind: "exact", usd: 0 });
  });
});

/**
 * The refinement §4 gained after metering moved to every physical round trip:
 * failed attempts write rows too, and a rule that ignored tokens would let one
 * 429 degrade a lifetime total to "≥ $X (1 unpriced)" forever.
 */
describe("a round trip rejected before any tokens were counted", () => {
  it("does not degrade the label: its cost is known to be zero, not unknown", () => {
    const summary = summarizeCost(costTotals([reported(1.23), rejectedBeforeTokens()]));

    expect(summary).toEqual({ kind: "exact", usd: 1.23 });
  });

  it("still counts a FAILED call that did consume tokens — that money was really spent", () => {
    const burned: CostRow = {
      costUsd: null,
      costSource: "unknown",
      inputTokens: 900,
      outputTokens: 0,
    };

    expect(summarizeCost(costTotals([reported(1.23), burned]))).toEqual({
      kind: "atLeast",
      usd: 1.23,
      unpricedCalls: 1,
    });
  });

  it("counts output-only tokens too — either side means the provider metered something", () => {
    const outputOnly: CostRow = {
      costUsd: null,
      costSource: "unknown",
      inputTokens: 0,
      outputTokens: 7,
    };

    expect(costTotals([outputOnly]).unpricedCalls).toBe(1);
  });

  it("adds nothing to the sum, so it cannot inflate the total either", () => {
    expect(costTotals([rejectedBeforeTokens()])).toEqual({
      usd: 0,
      unpricedCalls: 0,
      estimatedCalls: 0,
    });
  });
});

describe("costTotals", () => {
  it("never adds an unpriced row's cost into the sum — that is what makes SUM() lie", () => {
    expect(costTotals([unpriced(), reported(0.25)])).toEqual({
      usd: 0.25,
      unpricedCalls: 1,
      estimatedCalls: 0,
    });
  });

  it("treats a row marked unknown as unpriced even when it carries a figure", () => {
    // The two cannot disagree by construction. If a writer ever makes them
    // disagree, this is the reading the SQL aggregate takes as well — the two
    // paths answer one question and must not diverge.
    const lying: CostRow = {
      costUsd: 5,
      costSource: "unknown",
      inputTokens: 10,
      outputTokens: 1,
    };

    expect(costTotals([lying])).toEqual({ usd: 0, unpricedCalls: 1, estimatedCalls: 0 });
  });

  it("treats a null cost as unpriced even when the row claims to be priced", () => {
    const lying: CostRow = {
      costUsd: null,
      costSource: "provider_reported",
      inputTokens: 10,
      outputTokens: 1,
    };

    expect(costTotals([lying])).toEqual({ usd: 0, unpricedCalls: 1, estimatedCalls: 0 });
  });
});

describe("summarizeCost", () => {
  it("does not clamp a negative total away — money cannot be negative, so hiding it hides a bug", () => {
    expect(summarizeCost({ usd: -5, unpricedCalls: 0, estimatedCalls: 0 })).toEqual({
      kind: "exact",
      usd: -5,
    });
  });

  it("falls back to zero only for a total that is not a number at all", () => {
    expect(summarizeCost({ usd: Number.NaN, unpricedCalls: 0, estimatedCalls: 0 })).toEqual({
      kind: "exact",
      usd: 0,
    });
  });
});

describe("formatUsd", () => {
  it("shows a fraction of a cent instead of rounding a real cost to $0.00", () => {
    // What one Test call costs. toFixed(2) would print the same string an org
    // that has never spent anything sees.
    expect(formatUsd(0.000015)).toBe("$0.000015");
  });

  it("keeps two decimals once there is at least a cent", () => {
    expect(formatUsd(1.5)).toBe("$1.50");
    expect(formatUsd(0.01)).toBe("$0.01");
  });

  it("renders nothing spent as $0.00, not $0.000000", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });

  it("trims trailing zeros rather than emitting a broken string", () => {
    expect(formatUsd(0.0001)).toBe("$0.0001");
    // Below the ledger's own precision: floored, never "$0." and never "free".
    expect(formatUsd(1e-9)).toBe("$0.000001");
  });

  it("shows a negative total as negative instead of quietly printing $0.00", () => {
    expect(formatUsd(-5)).toBe("-$5.00");
    expect(formatUsd(-0.000015)).toBe("-$0.000015");
  });

  it("falls back to $0.00 only when the number is not a number", () => {
    expect(formatUsd(Number.NaN)).toBe("$0.00");
  });
});

/**
 * What actually goes into `numeric(12,6)`.
 *
 * `estimateCostUsd` floors a priced-from-table call at 0.000001 so a billed call
 * never stores 0.000000 — but OpenRouter, the only provider that reports its own
 * cost, never passes through that function. Without the same floor here, a
 * provider-reported 4e-7 call stores as zero and then reads "$0.000001" on the
 * Test line and "$0.00" in the org total: one call, two different numbers.
 */
describe("toLedgerCostUsd", () => {
  it("floors a real but sub-micro-dollar cost at the smallest amount the column can hold", () => {
    expect(toLedgerCostUsd(0.0000004)).toBe("0.000001");
  });

  it("writes an exact six-decimal string, not whatever String() decides to print", () => {
    expect(toLedgerCostUsd(0.00002)).toBe("0.000020");
    expect(toLedgerCostUsd(1e-7 * 3)).toBe("0.000001");
  });

  it("keeps a genuine zero as zero — a free model is not the same as an unpriced call", () => {
    expect(toLedgerCostUsd(0)).toBe("0.000000");
  });

  it("passes an unknown cost through as NULL, never as a number", () => {
    expect(toLedgerCostUsd(null)).toBeNull();
  });

  it("refuses to store a non-finite figure, which would poison every later SUM", () => {
    expect(toLedgerCostUsd(Number.NaN)).toBeNull();
    expect(toLedgerCostUsd(Number.POSITIVE_INFINITY)).toBeNull();
  });
});
