import { describe, expect, it } from "vitest";
import { estimateCostUsd, priceFor } from "./pricing.js";

describe("priceFor", () => {
  it("returns the introductory Gemini rate before 2027 and the standard one after", () => {
    expect(priceFor("google", "gemini-3.7-flash", new Date("2026-09-01"))).toEqual({
      inputPerMTok: 0.75,
      outputPerMTok: 3.75,
    });
    expect(priceFor("google", "gemini-3.7-flash", new Date("2027-02-01"))).toEqual({
      inputPerMTok: 1.5,
      outputPerMTok: 7.5,
    });
  });

  it("switches on the stroke of the effective date, not a day either side", () => {
    expect(priceFor("google", "gemini-3.7-flash", new Date("2026-12-31T23:59:59Z"))).toEqual({
      inputPerMTok: 0.75,
      outputPerMTok: 3.75,
    });
    expect(priceFor("google", "gemini-3.7-flash", new Date("2027-01-01T00:00:00Z"))).toEqual({
      inputPerMTok: 1.5,
      outputPerMTok: 7.5,
    });
  });

  it("returns null for a model it does not know, so cost is recorded as unknown", () => {
    expect(priceFor("openrouter", "someone/new-model", new Date())).toBeNull();
  });

  it("returns null for a provider it does not know", () => {
    expect(priceFor("anthropic", "claude-opus-5", new Date())).toBeNull();
  });
});

describe("estimateCostUsd rounding", () => {
  it("never rounds a call that cost something down to free", () => {
    // A cheap model — $0.05/MTok is well inside OpenRouter's range — makes a
    // one-token call cost 5e-8, which numeric(12,6) cannot express. Storing
    // 0.000000 would have the UI render a definite "≈ $0.00" for a billed call,
    // so the smallest unit the column can hold is the honest floor.
    const cheap = { inputPerMTok: 0.05, outputPerMTok: 0.05 };
    expect(estimateCostUsd(cheap, { inputTokens: 1, outputTokens: 0 })).toBe(0.000001);
  });

  it("still reports a genuinely zero-token call as zero", () => {
    const rate = { inputPerMTok: 0.75, outputPerMTok: 3.75 };
    expect(estimateCostUsd(rate, { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });
});

describe("estimateCostUsd", () => {
  it("prices input and output separately, per million tokens", () => {
    const rate = { inputPerMTok: 0.75, outputPerMTok: 3.75 };
    // 1M input at $0.75 plus 1M output at $3.75.
    expect(estimateCostUsd(rate, { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(4.5);
  });

  it("rounds to the ledger column's six decimal places", () => {
    const rate = { inputPerMTok: 0.75, outputPerMTok: 3.75 };
    expect(estimateCostUsd(rate, { inputTokens: 10, outputTokens: 5 })).toBe(0.000026);
  });
});
