import { describe, expect, it } from "vitest";
import {
  type ModelCallEnd,
  normalizeProviderName,
  providerReportedCostUsd,
  toUsageRecord,
} from "./usage.js";

describe("normalizeProviderName", () => {
  it("reduces the SDK's provider ids to the two the ledger stores", () => {
    expect(normalizeProviderName("google.generative-ai")).toBe("google");
    expect(normalizeProviderName("openrouter")).toBe("openrouter");
  });

  it("passes an unrecognised id through rather than coercing it", () => {
    // A provider we do not support should appear in the ledger as itself, not
    // masquerade as one we do.
    expect(normalizeProviderName("mock-provider")).toBe("mock-provider");
  });
});

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
});

describe("toUsageRecord", () => {
  const event: ModelCallEnd = {
    provider: "google.generative-ai",
    modelId: "gemini-3.7-flash",
    usage: {
      inputTokens: 1000,
      inputTokenDetails: { cacheReadTokens: 400 },
      outputTokens: 200,
      outputTokenDetails: { reasoningTokens: 150 },
    },
    performance: { responseTimeMs: 812.4 },
  };

  it("maps the flat telemetry shape onto the ledger row", () => {
    expect(toUsageRecord(event, { attempt: 1, status: "ok", at: new Date("2026-09-01") })).toEqual({
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
    const after = toUsageRecord(event, { attempt: 1, status: "ok", at: new Date("2027-02-01") });
    expect(after.costUsd).toBe(0.003);
  });

  it("records unknown, not zero, for a model the table has never heard of", () => {
    const record = toUsageRecord(
      { ...event, modelId: "gemini-9.9-imaginary" },
      { attempt: 1, status: "ok", at: new Date("2026-09-01") },
    );
    expect(record.costUsd).toBeNull();
    expect(record.costSource).toBe("unknown");
  });

  it("prefers the provider's own figure over the table's estimate", () => {
    const record = toUsageRecord(
      { ...event, providerMetadata: { openrouter: { usage: { cost: 0.9 } } } },
      { attempt: 1, status: "ok", at: new Date("2026-09-01") },
    );
    expect(record.costUsd).toBe(0.9);
    expect(record.costSource).toBe("provider_reported");
  });

  it("tolerates a telemetry event with no usage or timing at all", () => {
    const record = toUsageRecord(
      { provider: "openrouter", modelId: "x/y", usage: {} },
      { attempt: 2, status: "errored", at: new Date() },
    );
    expect(record).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      responseMs: 0,
      status: "errored",
      attempt: 2,
      costSource: "unknown",
    });
  });
});
