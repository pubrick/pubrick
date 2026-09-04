import { createGoogleGenerativeAI } from "@ai-sdk/google";
// `ai` imports LanguageModelV4 but does not re-export it, and its own
// `LanguageModel` is a union that includes a bare gateway model-id string — so a
// function returning it hands callers something they cannot read `.modelId` off.
// Declaring @ai-sdk/provider directly costs nothing: `ai` pins it exactly, so the
// range resolves to the very copy already in the tree (checked by
// `pnpm -r ls @ai-sdk/provider --depth 10`, which must show one version).
import type { LanguageModelV4, SharedV4ProviderOptions } from "@ai-sdk/provider";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { type AiProviderId, PermanentError } from "@pubrick/shared";
import { withRunFailure } from "./classify.js";

/**
 * Providers a BYOK key can be stored for.
 *
 * Re-exported from `@pubrick/shared`, not restated. This package used to keep
 * its own copy and `@pubrick/db` a third, held together by a pin test in
 * apps/api; there is one list now, and `AiProvider` is an alias of its member
 * type rather than a second name for a second union.
 */
export { AI_PROVIDERS } from "@pubrick/shared";
export type AiProvider = AiProviderId;

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
 * Gemini 3.7 Flash is the house default: it is fast, cheap, and it does
 * structured output. The OpenRouter default routes to the same model through
 * their catalogue so a user switching providers gets the same behaviour rather
 * than a surprise.
 *
 * It is no longer the only id the price table can price — that changed on
 * 2026-09-02, when the table started matching by model FAMILY — but a model the
 * table does not know still costs an org a permanent "cost not reported" on
 * every one of its calls, so `pricing.ts` is where a new default belongs
 * first.
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
    throw withRunFailure(
      new PermanentError(`no API key stored for provider "${credential.provider}"`),
      "no_api_key",
    );
  }

  switch (credential.provider) {
    case "google":
      return createGoogleGenerativeAI({ apiKey: credential.apiKey })(id);
    case "openrouter":
      return createOpenRouter({ apiKey: credential.apiKey })(id);
  }
}

/**
 * How much reasoning to buy on a call that is a CONNECTIVITY CHECK rather than
 * a reasoning task.
 *
 * `"low"`, not `"minimal"`, and the difference is not a matter of taste.
 * Google's own thinking-level table (ai.google.dev/gemini-api/docs/thinking,
 * read 2026-09-04) lists `low, medium, high` for `gemini-3.7-flash` — the house
 * default — while `minimal` appears only for 3.6 Flash and the 3.5 pair. A
 * `minimal` sent to the very model this exists for is a 400, and a 400 on the
 * Test button does not read as "we asked for something the model does not
 * support"; it reads as "your API key was refused". The whole job of that
 * button is to tell the truth about a key, so the level is the lowest one the
 * default model actually accepts.
 *
 * One level for both providers because both accept this word: Google takes it
 * as `thinkingConfig.thinkingLevel`, OpenRouter as `reasoning.effort`.
 */
const PROBE_THINKING_LEVEL = "low";

/**
 * Provider options that ask for the least reasoning a connectivity probe can
 * get away with — or `undefined`, meaning "send nothing extra".
 *
 * WHY IT IS WORTH ASKING. The probe's prompt is two words. Its ANSWER is two
 * words. Everything else it is billed for is thinking the model does by
 * default, at the output rate (Gemini 3.x bills thinking tokens as output, see
 * `UsageRecord.reasoningTokens`) — which is most of the cost of a call whose
 * entire content is `{"ok": true}`.
 *
 * WHY ONLY FOR THE DEFAULT MODEL, and this is the load-bearing half. An org can
 * type any model id into the Settings field. `thinkingConfig` on a model that
 * does no thinking at all — Gemini 2.0, the Gemma family — is rejected by the
 * API, and a rejection here is reported to the user as a verdict about their
 * KEY. Saving a fraction of a cent must not buy a false "the provider refused
 * this API key" on the one screen that exists to answer that question, so the
 * hint is sent only for the id THIS package chose, whose accepted levels have
 * been read off the vendor's table. A model the org named is the org's, and it
 * is sent nothing it did not ask for.
 */
export function probeThinkingOptions(
  provider: AiProvider,
  modelId: string,
): SharedV4ProviderOptions | undefined {
  if (modelId !== DEFAULT_MODELS[provider]) return undefined;
  switch (provider) {
    case "google":
      // `thinkingLevel` alone. Google's API supersedes `thinking_budget` with
      // it and rejects a request carrying both — see `resolveModel` above.
      return { google: { thinkingConfig: { thinkingLevel: PROBE_THINKING_LEVEL } } };
    case "openrouter":
      return { openrouter: { reasoning: { effort: PROBE_THINKING_LEVEL } } };
  }
}
