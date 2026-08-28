import { z } from "zod";
import type { CostSummary } from "../cost-display.js";

/**
 * Model providers a BYOK key can be stored for.
 *
 * Third hand-maintained copy of one list: `@pubrick/db` owns the column enum and
 * `@pubrick/ai` owns the provider factory. Neither can import this package's
 * enum today — `@pubrick/db` does not depend on `@pubrick/shared` at all, and
 * `@pubrick/ai`'s copy predates this one — so `apps/api/src/ai-providers.spec.ts`
 * pins all three, at the type level and the value level, exactly as
 * `platforms.spec.ts` pins the platform list. A provider added to one list and
 * not the others is then a failing gate, not a 500 the first time someone saves
 * a key.
 */
export const AI_PROVIDERS = ["google", "openrouter"] as const;
export type AiProviderId = (typeof AI_PROVIDERS)[number];

export const aiProviderSchema = z.enum(AI_PROVIDERS);

/**
 * Saving a key. `PUT` rather than `POST`: an org has at most one key per
 * provider (a unique index says so), so a second save replaces the first
 * instead of creating a duplicate the user cannot tell apart.
 *
 * `defaultModel` is optional because the column is nullable and null has a
 * meaning — "use the provider's built-in default", the branch
 * `resolveModel` implements. Requiring a value here would make that branch
 * unreachable and force the UI to hardcode a model id that lives in
 * `@pubrick/ai`. An empty string is rejected rather than silently coerced:
 * the caller omits the field.
 */
export const aiCredentialUpsertSchema = z.object({
  provider: aiProviderSchema,
  // Lower bound catches a pasted-empty or truncated key before it becomes a
  // provider 401 the user reads as "my key is wrong". Upper bound matches the
  // channel-credential cap, so one field cannot be used to store a document.
  apiKey: z.string().min(8).max(4096),
  defaultModel: z.string().min(1).max(200).optional(),
});
export type AiCredentialUpsert = z.infer<typeof aiCredentialUpsertSchema>;

/**
 * What every credential endpoint returns.
 *
 * There is no key field and no `id`: the resource is addressed by provider,
 * and the encrypted blob is excluded by the repository's column allowlist. The
 * e2e asserts the absence against the whole JSON body, not against this type —
 * a type cannot stop a repository from selecting a column it should not.
 */
export type AiCredentialPublic = {
  provider: AiProviderId;
  defaultModel: string | null;
  updatedAt: string;
};

/**
 * The result of one Test call.
 *
 * A rejected key is a *result*, not a 5xx — same rule the channel verify
 * endpoint follows. `cost` carries the three display rules rather than a bare
 * number, so a provider that reported no cost renders as "unpriced" and never
 * as "$0.00".
 */
export type AiCredentialTestResult =
  | { ok: true; modelId: string; cost: CostSummary }
  | { ok: false; reason: string };
