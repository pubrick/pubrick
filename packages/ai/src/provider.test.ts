import { PermanentError } from "@pubrick/shared";
import { describe, expect, it } from "vitest";
import {
  type AiCredential,
  DEFAULT_MODELS,
  probeThinkingOptions,
  resolveModel,
} from "./provider.js";

// Building a model is entirely local — no provider is contacted here, and no
// test in this package ever contacts one.
const google: AiCredential = { provider: "google", apiKey: "test-key" };
const openrouter: AiCredential = { provider: "openrouter", apiKey: "test-key" };

describe("resolveModel", () => {
  it("builds a Gemini model on the house default", () => {
    const model = resolveModel(google);
    expect(model.provider).toBe("google.generative-ai");
    expect(model.modelId).toBe(DEFAULT_MODELS.google);
  });

  it("builds an OpenRouter model, whose ids are vendor/model", () => {
    const model = resolveModel(openrouter);
    expect(model.provider).toBe("openrouter");
    expect(model.modelId).toBe("google/gemini-3.7-flash");
  });

  it("prefers the explicit model id over the credential's default", () => {
    const model = resolveModel({ ...google, defaultModel: "gemini-3.7-pro" }, "gemini-3.7-flash");
    expect(model.modelId).toBe("gemini-3.7-flash");
  });

  it("falls back to the credential's default when the call names none", () => {
    const model = resolveModel({ ...google, defaultModel: "gemini-3.7-pro" });
    expect(model.modelId).toBe("gemini-3.7-pro");
  });

  it("treats a null default_model as 'use the house default', matching the nullable column", () => {
    const model = resolveModel({ ...google, defaultModel: null });
    expect(model.modelId).toBe(DEFAULT_MODELS.google);
  });

  it("refuses an empty key rather than letting it become a confusing 401", () => {
    expect(() => resolveModel({ ...google, apiKey: "  " })).toThrow(PermanentError);
  });

  it("resolves both providers to the same model spec version, so one call site fits both", () => {
    expect(resolveModel(google).specificationVersion).toBe(
      resolveModel(openrouter).specificationVersion,
    );
  });
});

/**
 * The Test button is a connectivity check, not a reasoning task, and the model
 * reasons by default — at the OUTPUT rate on Gemini 3.x. Asking for less is
 * most of the saving available on a call whose entire content is `{"ok":true}`.
 *
 * What these pin is the boundary, not the saving: WHICH level, and for WHICH
 * models. Both were chosen against the vendors' own tables, and getting either
 * wrong turns a working key into "the provider refused this API key" on the one
 * screen that exists to answer that question.
 */
describe("probeThinkingOptions", () => {
  it("asks Google for the lowest level gemini-3.7-flash actually accepts", () => {
    // NOT "minimal". Google's thinking-level table (read 2026-09-04) lists
    // `low, medium, high` for 3.7 Flash and offers `minimal` only on 3.6 and
    // the 3.5 pair — so `minimal` on the house default is a 400, which this
    // button would report as a rejected key.
    expect(probeThinkingOptions("google", DEFAULT_MODELS.google)).toEqual({
      google: { thinkingConfig: { thinkingLevel: "low" } },
    });
  });

  it("asks OpenRouter for the same level, in OpenRouter's own spelling", () => {
    expect(probeThinkingOptions("openrouter", DEFAULT_MODELS.openrouter)).toEqual({
      openrouter: { reasoning: { effort: "low" } },
    });
  });

  it("sends a thinking budget and never a level, which the API refuses together", () => {
    // `thinking_level` supersedes `thinking_budget` and a request carrying both
    // is a 400 — see `resolveModel`. Only one of the two may ever appear.
    const options = probeThinkingOptions("google", DEFAULT_MODELS.google) as {
      google: { thinkingConfig: Record<string, unknown> };
    };
    expect(Object.keys(options.google.thinkingConfig)).toEqual(["thinkingLevel"]);
  });

  it("sends nothing for a model the org named itself", () => {
    // The Settings screen takes any model id. A thinking knob is a 400 on a
    // model that does no thinking (Gemini 2.0, the Gemma family), and a 400
    // here reads as "your key was rejected" — so a fraction of a cent must not
    // buy a false verdict on a working key.
    expect(probeThinkingOptions("google", "gemini-2.0-flash")).toBeUndefined();
    expect(probeThinkingOptions("google", "gemma-3-27b-it")).toBeUndefined();
    // Including one that would very likely have worked: the rule is "an id we
    // checked", not "an id we think is fine".
    expect(probeThinkingOptions("google", "gemini-3.6-flash")).toBeUndefined();
    expect(probeThinkingOptions("openrouter", "anthropic/claude-3.5-sonnet")).toBeUndefined();
  });

  it("does not lend one provider's default to the other", () => {
    // The ids differ (`gemini-3.7-flash` vs `google/gemini-3.7-flash`), and a
    // check that compared against both providers' defaults at once would send
    // Google an id OpenRouter routes.
    expect(probeThinkingOptions("google", DEFAULT_MODELS.openrouter)).toBeUndefined();
    expect(probeThinkingOptions("openrouter", DEFAULT_MODELS.google)).toBeUndefined();
  });
});
