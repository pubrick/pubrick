import { describe, expect, it } from "vitest";
import { type MeteredCall, providerReportedCostUsd, toUsageRecord } from "./usage.js";

describe("providerReportedCostUsd", () => {
  it("reads the cost OpenRouter reports", () => {
    expect(providerReportedCostUsd({ openrouter: { usage: { cost: 0.004 } } })).toBe(0.004);
  });

  it("returns null when the optional field is absent at any level", () => {
    expect(providerReportedCostUsd(undefined)).toBeNull();
    expect(providerReportedCostUsd({})).toBeNull();
    expect(providerReportedCostUsd({ openrouter: {} })).toBeNull();
    expect(providerReportedCostUsd({ openrouter: { usage: {} } })).toBeNull();
  });

  it("ignores a non-numeric value instead of coercing it", () => {
    expect(providerReportedCostUsd({ openrouter: { usage: { cost: "0.004" } } })).toBeNull();
    expect(providerReportedCostUsd({ openrouter: { usage: { cost: Number.NaN } } })).toBeNull();
  });

  it("rejects a negative cost rather than crediting it against the run", () => {
    // No call earns money. A negative figure is a provider bug or a field we
    // have misread; either way it must not reduce the org's spend-to-date.
    expect(providerReportedCostUsd({ openrouter: { usage: { cost: -1.5 } } })).toBeNull();
  });
});

describe("toUsageRecord", () => {
  // The nested provider-level usage shape, which is what
  // `executeLanguageModelCall`'s `execute()` resolves to.
  const call: MeteredCall = {
    modelId: "gemini-3.7-flash",
    responseMs: 812.4,
    transportOk: true,
    result: {
      usage: {
        inputTokens: { total: 1000, cacheRead: 400 },
        outputTokens: { total: 200, reasoning: 150 },
      },
    },
  };
  const at = new Date("2026-09-01");

  it("maps the nested provider usage shape onto the ledger row", () => {
    expect(toUsageRecord(call, { provider: "google", attempt: 1, status: "ok", at })).toEqual({
      provider: "google",
      modelId: "gemini-3.7-flash",
      attempt: 1,
      inputTokens: 1000,
      outputTokens: 200,
      cachedInputTokens: 400,
      reasoningTokens: 150,
      costUsd: 0.0015,
      costSource: "price_table",
      responseMs: 812,
      status: "ok",
    });
  });

  it("prices the same call higher after the 2027 rate change, from data alone", () => {
    const after = toUsageRecord(call, {
      provider: "google",
      attempt: 1,
      status: "ok",
      at: new Date("2027-02-01"),
    });
    expect(after.costUsd).toBe(0.003);
  });

  it("records unknown, not zero, for a model the table has never heard of", () => {
    const record = toUsageRecord(
      { ...call, modelId: "gemini-9.9-imaginary" },
      { provider: "google", attempt: 1, status: "ok", at },
    );
    expect(record.costUsd).toBeNull();
    expect(record.costSource).toBe("unknown");
  });

  it("records unknown when the provider reported no usage for a model it knows", () => {
    // The SDK types every token count `number | undefined`. Multiplying a
    // missing count by a known rate yields 0, which the display rules render as
    // a definite "≈ $0.00" — a confident claim that a billed call was free.
    const record = toUsageRecord(
      { modelId: "gemini-3.7-flash", responseMs: 5, transportOk: true, result: {} },
      { provider: "google", attempt: 1, status: "ok", at },
    );
    expect(record.costUsd).toBeNull();
    expect(record.costSource).toBe("unknown");
  });

  it("records unknown for a round trip that threw before reporting anything", () => {
    const record = toUsageRecord(
      { modelId: "gemini-3.7-flash", responseMs: 20, transportOk: false },
      { provider: "google", attempt: 1, status: "errored", at },
    );
    expect(record).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      costSource: "unknown",
      status: "errored",
    });
  });

  it("prefers the provider's own figure over the table's estimate", () => {
    const record = toUsageRecord(
      {
        ...call,
        result: { ...call.result, providerMetadata: { openrouter: { usage: { cost: 0.9 } } } },
      },
      { provider: "openrouter", attempt: 1, status: "ok", at },
    );
    expect(record.costUsd).toBe(0.9);
    expect(record.costSource).toBe("provider_reported");
  });

  it("prices a two-token call rather than rounding it away", () => {
    const record = toUsageRecord(
      {
        modelId: "gemini-3.7-flash",
        responseMs: 1,
        transportOk: true,
        result: { usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
      },
      { provider: "google", attempt: 1, status: "ok", at },
    );
    // (0.75 + 3.75) / 1e6, at the column's six decimal places.
    expect(record.costUsd).toBe(0.000005);
    expect(record.costSource).toBe("price_table");
  });
});
