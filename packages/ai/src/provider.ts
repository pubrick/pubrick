import { createGoogleGenerativeAI } from "@ai-sdk/google";
// `ai` imports LanguageModelV4 but does not re-export it, and its own
// `LanguageModel` is a union that includes a bare gateway model-id string — so a
// function returning it hands callers something they cannot read `.modelId` off.
// Declaring @ai-sdk/provider directly costs nothing: `ai` pins it exactly, so the
// range resolves to the very copy already in the tree (checked by
// `pnpm -r ls @ai-sdk/provider --depth 10`, which must show one version).
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { PermanentError } from "@pubrick/shared";

/** Providers a BYOK key can be stored for. Mirrors `AI_PROVIDERS` in `@pubrick/db`. */
export const AI_PROVIDERS = ["google", "openrouter"] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

/**
 * An org's key, already decrypted.
 *
 * Decryption belongs to the repository that owns `ai_credentials`, not here:
 * this package has no database dependency and must not grow one. `defaultModel`
 * is nullable in that table — null means "use the provider's default" — so it is
 * optional here too.
 */
export type AiCredential = {
  provider: AiProvider;
  apiKey: string;
  defaultModel?: string | null;
};

/**
 * The model used when neither the call nor the credential names one.
 *
 * Gemini 3.7 Flash is the house default: it is the tier the price table knows,
 * and it does structured output. The OpenRouter default routes to the same
 * model through their catalogue so a user switching providers gets the same
 * behaviour rather than a surprise.
 */
export const DEFAULT_MODELS: Record<AiProvider, string> = {
  google: "gemini-3.7-flash",
  openrouter: "google/gemini-3.7-flash",
};

/**
 * Build a language model from an org's credential.
 *
 * Sampling parameters are deliberately not set. On Gemini 3.x they are
 * deprecated but still functional, and Google recommends leaving `temperature`
 * at its default of 1.0; `thinking_level` supersedes `thinking_budget` and
 * sending both is a 400. A knob whose vendor recommends never touching it is
 * chrome that invites misuse, so neither this function nor the settings UI
 * exposes one.
 */
export function resolveModel(credential: AiCredential, modelId?: string): LanguageModelV4 {
  const id = modelId ?? credential.defaultModel ?? DEFAULT_MODELS[credential.provider];

  if (credential.apiKey.trim() === "") {
    // Caught here rather than at the first call: an empty key produces a
    // provider 401 that reads like the user's key was rejected, which sends
    // them to re-copy a key that was never saved.
    throw new PermanentError(`no API key stored for provider "${credential.provider}"`);
  }

  switch (credential.provider) {
    case "google":
      return createGoogleGenerativeAI({ apiKey: credential.apiKey })(id);
    case "openrouter":
      return createOpenRouter({ apiKey: credential.apiKey })(id);
  }
}
