import { z } from "zod";
import { type AiProviderId, aiProviderSchema } from "./dto/ai-credentials.js";
import { PermanentError } from "./errors.js";

/** Explicit vendor identifiers, shared with the browser and transactional admissions. */
export const DEFAULT_TEXT_MODELS: Record<AiProviderId, string> = {
  google: "gemini-3.8-flash",
  openrouter: "google/gemini-3.8-flash",
  openai: "gpt-6-luna",
  anthropic: "claude-sonnet-5-5",
  deepseek: "deepseek-flash",
};

export const aiTextSnapshotSchema = z.object({
  provider: aiProviderSchema,
  modelId: z.string().trim().min(1).max(200),
  credentialId: z.uuid(),
  credentialRevision: z.number().int().positive(),
  settingsRevision: z.number().int().nonnegative(),
});
export type AiTextSnapshot = z.infer<typeof aiTextSnapshotSchema>;
export const aiTextSettingsUpdateSchema = z.object({
  provider: aiProviderSchema,
  model: z.string().trim().min(1).max(200).nullable(),
  expectedRevision: z.number().int().nonnegative(),
});
export type AiTextSettingsUpdate = z.infer<typeof aiTextSettingsUpdateSchema>;
export const aiTextSettingsSchema = z.object({
  provider: aiProviderSchema.nullable(),
  model: z.string().nullable(),
  modelId: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  configured: z.boolean(),
});
export type AiTextSettings = z.infer<typeof aiTextSettingsSchema>;

/** A refusal before provider HTTP; retry creates a fresh, visible configuration. */
export class AiTextSelectionChangedError extends PermanentError {
  readonly runFailure = "configuration_changed";
  constructor(
    message = "The selected AI key changed or was removed. Review Settings, then retry.",
  ) {
    super(message);
  }
}

/** Image/embedding usage does not establish a text provider's history. */
export function isTextPipelineStep(step: string): boolean {
  return (
    ["researcher", "writer", "editor", "factcheck", "seo_polish"].includes(step) ||
    step.startsWith("adapter:")
  );
}

/** Never invent provenance for partially completed runs with missing accounting. */
export function legacyTextIdentity(
  rows: readonly { provider: AiProviderId; modelId: string; step: string }[],
  hasCheckpoints: boolean,
  unrecordedCalls: number | null,
): { provider: AiProviderId; modelId: string } | null {
  const text = rows.filter((row) => isTextPipelineStep(row.step));
  if (unrecordedCalls === null || unrecordedCalls > 0 || (hasCheckpoints && text.length === 0))
    throw new AiTextSelectionChangedError(
      "This legacy run has incomplete AI provenance. Retry it to use the current Settings.",
    );
  if (!text.length) return null;
  const first = text[0];
  if (
    !first ||
    text.some((row) => row.provider !== first.provider || row.modelId !== first.modelId)
  )
    throw new AiTextSelectionChangedError(
      "This legacy run used multiple AI configurations. Retry it with one selected provider.",
    );
  return { provider: first.provider, modelId: first.modelId };
}
