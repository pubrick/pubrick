import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import {
  callOutcomeOf,
  type MeteredCall,
  providerReportedCostUsd,
  toUsageRecord,
} from "./usage.js";

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

/**
 * The verdict that decides whether a zero-token row is free or a floor.
 *
 * It can only be reached inside the recorder's `catch`, because it is the last
 * place the error exists: by the time the ledger row is written a refusal and a
 * lost generation are the same four columns.
 */
describe("callOutcomeOf", () => {
  function apiError(statusCode?: number) {
    return new APICallError({
      message: "boom",
      url: "https://example.invalid",
      requestBodyValues: {},
      ...(statusCode === undefined ? {} : { statusCode }),
    });
  }

  it("reads a refusal off a non-2xx status — a verdict delivered instead of work", () => {
    // Nothing was generated, so nothing was billed. This is the row the IGNORED
    // bucket exists for, and the reason a flaky provider cannot stamp "≥" on an
    // org's lifetime total.
    expect(callOutcomeOf(apiError(429))).toBe("refused");
    expect(callOutcomeOf(apiError(401))).toBe("refused");
    expect(callOutcomeOf(apiError(500))).toBe("refused");
  });

  it("calls a 2xx that still threw unknown — the model finished and we could not read it", () => {
    // `createJsonResponseHandler` throws `APICallError` with the SUCCESSFUL
    // status when the body does not match the provider's schema. A rule reading
    // "any status means refused" would file the most expensive failure of all —
    // a whole generation, paid for, unparseable — as free.
    expect(callOutcomeOf(apiError(200))).toBe("unknown");
    expect(callOutcomeOf(apiError(299))).toBe("unknown");
  });

  it("puts the boundary at 300, so a redirect is still a verdict", () => {
    expect(callOutcomeOf(apiError(300))).toBe("refused");
  });

  it("calls a provider error with NO status unknown", () => {
    // The SDK wraps a connect failure as `APICallError` with `statusCode`
    // undefined. Some of those really did reach nobody — and the error does not
    // say which, so "we cannot tell" is the only honest answer.
    expect(callOutcomeOf(apiError())).toBe("unknown");
  });

  it("calls a timeout, an abort and anything else unknown", () => {
    expect(callOutcomeOf(new DOMException("aborted due to timeout", "TimeoutError"))).toBe(
      "unknown",
    );
    expect(callOutcomeOf(new DOMException("This operation was aborted", "AbortError"))).toBe(
      "unknown",
    );
    expect(callOutcomeOf(new TypeError("fetch failed"))).toBe("unknown");
    expect(callOutcomeOf("a thrown string")).toBe("unknown");
    expect(callOutcomeOf(undefined)).toBe("unknown");
  });
});

describe("toUsageRecord", () => {
  // The nested provider-level usage shape, which is what
  // `executeLanguageModelCall`'s `execute()` resolves to.
  const call: MeteredCall = {
    modelId: "gemini-3.7-flash",
    responseMs: 812.4,
    transportOk: true,
    outcome: "completed",
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
      outcome: "completed",
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
      {
        modelId: "gemini-3.7-flash",
        responseMs: 5,
        transportOk: true,
        outcome: "completed",
        result: {},
      },
      { provider: "google", attempt: 1, status: "ok", at },
    );
    expect(record.costUsd).toBeNull();
    expect(record.costSource).toBe("unknown");
  });

  it("records unknown for a round trip that threw before reporting anything", () => {
    const record = toUsageRecord(
      { modelId: "gemini-3.7-flash", responseMs: 20, transportOk: false, outcome: "refused" },
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

  it("carries the round trip's outcome onto the row unchanged", () => {
    // Nothing downstream can re-derive it: a refusal and a lost generation both
    // arrive here with zero tokens and no cost, and the error that told them
    // apart is two frames gone.
    for (const outcome of ["completed", "refused", "unknown"] as const) {
      const record = toUsageRecord(
        { modelId: "gemini-3.7-flash", responseMs: 20, transportOk: false, outcome },
        { provider: "google", attempt: 1, status: "errored", at },
      );
      expect(record.outcome).toBe(outcome);
    }
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

  it("falls back to the Google table when OpenRouter reported no cost for a google/ id", () => {
    // OpenRouter's cost field is optional and its absence used to mean the row
    // was unpriced for ever — even though the id names a Google model this
    // table knows the published rate for. The report still wins whenever there
    // is one (the test above); this is only for when there is not.
    const record = toUsageRecord(
      { ...call, modelId: "google/gemini-3.7-flash" },
      { provider: "openrouter", attempt: 1, status: "ok", at },
    );
    expect(record.costUsd).toBe(0.0015);
    expect(record.costSource).toBe("price_table");
  });

  it("still records unknown for an OpenRouter id this table cannot price", () => {
    for (const modelId of ["anthropic/claude-opus-5", "google/gemini-3.7-flash:free"]) {
      const record = toUsageRecord(
        { ...call, modelId },
        { provider: "openrouter", attempt: 1, status: "ok", at },
      );
      expect(record.costUsd).toBeNull();
      expect(record.costSource).toBe("unknown");
    }
  });

  it("prices a two-token call rather than rounding it away", () => {
    const record = toUsageRecord(
      {
        modelId: "gemini-3.7-flash",
        responseMs: 1,
        transportOk: true,
        outcome: "completed",
        result: { usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
      },
      { provider: "google", attempt: 1, status: "ok", at },
    );
    // (0.75 + 3.75) / 1e6, at the column's six decimal places.
    expect(record.costUsd).toBe(0.000005);
    expect(record.costSource).toBe("price_table");
  });
});
