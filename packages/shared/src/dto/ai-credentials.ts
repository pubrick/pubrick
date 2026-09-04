import { z } from "zod";
import type { CostSummary } from "../cost-display.js";

/**
 * Model providers a BYOK key can be stored for — the one declaration.
 *
 * It was three hand-maintained copies of one list: `@pubrick/db` had the column
 * enum, `@pubrick/ai` had the provider factory's, and this was the zod enum the
 * API validates bodies and path parameters against. Neither of the other two
 * could import this one — `@pubrick/db` had no dependency on this package at
 * all — so `apps/api/src/ai-providers.spec.ts` pinned all three at the type and
 * value level. `@pubrick/db` now depends on this package and both other copies
 * are gone, which is why that pin test is gone with them: it compared a value
 * against itself.
 *
 * Drift used to mean a provider the API accepts and the column rejects (a 500
 * on save), or one the column allows and no factory can build (a 500 on the
 * first call). Neither is expressible from one list.
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
 * Why a Test call failed — a closed set of codes, never a sentence.
 *
 * The provider's own error text is NEVER passed through, and the reason is
 * structural: providers echo the submitted key back in their error bodies
 * ("Incorrect API key provided: sk-live-…"), and this value is returned to a
 * browser. A code cannot carry a secret however the provider words its 401. It
 * is also the only way this screen can answer in four languages, which a
 * provider's English sentence never could.
 *
 * `unreadable_key` is the stored blob failing to decrypt — the key predates a
 * rotated `APP_ENCRYPTION_KEY`, or the row was tampered with. It is a verdict
 * about the key, so it belongs here rather than in a 500 with a crypto stack.
 *
 * `timed_out` is our own two-minute call budget expiring before the provider
 * answered (`MODEL_CALL_TIMEOUT_MS`). It exists as a member because the nearest
 * alternative was a lie: with only the six codes above, a timed-out Test was
 * reported as `rate_limited` — telling the user the provider was busy when the
 * provider had said nothing at all, and pointing them at a wait instead of at a
 * model or a network that is not answering. It mirrors `RUN_FAILURES`'
 * `timed_out` one-for-one, which is what `TEST_FAILURE_FOR_RUN_FAILURE` in
 * `ai-credentials.probe.ts` now makes structural rather than remembered.
 *
 * `too_many_tests` is OURS and not the provider's — the org has spent its hourly
 * budget of test calls (`MAX_TEST_CALLS_PER_HOUR`). It is a separate member from
 * `rate_limited` deliberately: that one means the vendor said no and the advice
 * is to try again shortly, this one means WE said no and the advice is different.
 * Collapsing them would put a sentence about the provider on a refusal the
 * provider never made — the same lie `timed_out` was carved out of.
 *
 * It is a 200 with a verdict rather than a 429, for the reason the endpoint
 * returns 200 on both arms at all: "your key was not exercised, and here is
 * why" is a RESULT the settings screen renders in the reader's language, and a
 * status code is not a thing four locales can translate. `refusalBody`'s status
 * set is closed at 400/403/404/409 for its own documented reasons, and widening
 * it for one caller would buy this refusal an English sentence on a Spanish
 * screen — precisely what the closed code sets exist to prevent.
 */
export const AI_TEST_FAILURES = [
  "invalid_key",
  "model_not_found",
  "no_structured_output",
  "rate_limited",
  "refused",
  "timed_out",
  "too_many_tests",
  "unreadable_key",
] as const;
export type AiTestFailure = (typeof AI_TEST_FAILURES)[number];

/**
 * How many BILLED model calls one organisation's Test button may make in a
 * rolling hour.
 *
 * WHY THERE IS A NUMBER HERE AT ALL. `POST /api/ai-credentials/:provider/test`
 * was guarded by membership and nothing else: no role, no limit, and the api
 * has no throttler of any kind. Every press is one live model call — two when
 * the model violates the schema and the repair retry fires — against the
 * organisation's own key. At an estimated $0.0004–$0.004 a press, a member with
 * a `for` loop at ten presses a second could spend on the order of $140 an hour
 * of somebody else's money, bounded only by the vendor's own limit.
 *
 * WHY SIXTY, AND WHY COUNTED IN CALLS. The unit is the thing being protected:
 * the ledger already writes one row per PHYSICAL call, so a press that costs two
 * calls consumes two, and the limit is a bound on money rather than on clicks.
 * Sixty an hour is at worst about $0.24 an hour — roughly six hundred times
 * smaller than the hole, and small enough to be noise on any real bill.
 *
 * The other half of the judgement is the one that decides the number: a limit
 * that makes an honest user wait is worse than the problem it solves. Honest use
 * is a person on the Settings screen who has just pasted a key — press, read,
 * maybe fix the model id and press again. There is one Test button per stored
 * provider and there are two providers, so a thorough session is a handful of
 * presses; sixty calls is between thirty and sixty of them, which no
 * configuration session approaches and no support call reaches either. The
 * number is deliberately far above honest use and far below abuse, because the
 * gap between those two is four orders of magnitude wide and there is no reason
 * to shave it.
 *
 * ROLLING HOUR, NOT A BUCKET IN MEMORY. Counted from `usage_ledger` rows the
 * calls themselves wrote, which makes the limit one number for the whole
 * deployment rather than one per api replica, and survives a restart — an
 * in-process counter would hand a fresh budget to anyone who waited for a
 * deploy. It also means a Test that spent nothing (an unreadable key, refused
 * before any call) consumes nothing: what is limited is exactly what costs.
 */
export const MAX_TEST_CALLS_PER_HOUR = 60;

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
  | { ok: false; reason: AiTestFailure };
