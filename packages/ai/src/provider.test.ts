import { PermanentError } from "@pubrick/shared";
import { describe, expect, it } from "vitest";
import { type AiCredential, DEFAULT_MODELS, resolveModel } from "./provider.js";

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
