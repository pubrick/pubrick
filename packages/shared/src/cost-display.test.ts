import { describe, expect, it } from "vitest";
import { type CostRow, costTotals, formatUsd, summarizeCost } from "./cost-display.js";

const reported = (usd: number): CostRow => ({ costUsd: usd, costSource: "provider_reported" });
const estimated = (usd: number): CostRow => ({ costUsd: usd, costSource: "price_table" });
const unpriced = (): CostRow => ({ costUsd: null, costSource: "unknown" });

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

describe("costTotals", () => {
  it("never adds an unpriced row's cost into the sum — that is what makes SUM() lie", () => {
    expect(costTotals([unpriced(), reported(0.25)])).toEqual({
      usd: 0.25,
      unpricedCalls: 1,
      estimatedCalls: 0,
    });
  });

  it("treats a null cost as unpriced even when the row claims to be priced", () => {
    // The two cannot disagree by construction; if a writer ever makes them
    // disagree, under-claiming knowledge is the safe direction.
    const lying: CostRow = { costUsd: null, costSource: "provider_reported" };

    expect(costTotals([lying])).toEqual({ usd: 0, unpricedCalls: 1, estimatedCalls: 0 });
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

  it("refuses to render a negative or non-finite total", () => {
    expect(formatUsd(-5)).toBe("$0.00");
    expect(formatUsd(Number.NaN)).toBe("$0.00");
  });
});
