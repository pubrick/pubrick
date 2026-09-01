import type { AiProviderId } from "./dto/ai-credentials.js";

/**
 * The two columns the ordering reads.
 *
 * Callers pass their own row type and get it back: the repositories select the
 * ciphertext and the default model alongside these, and the point of the
 * function is to hand back the row they can decrypt.
 */
export type CredentialOrderRow = {
  provider: AiProviderId;
  createdAt: Date;
};

/**
 * Which of an org's BYOK keys a call that names no provider reaches: the
 * OLDEST one it configured, ties broken by provider name ascending.
 *
 * Nothing records a provider on a run — there is no per-run model choice — so
 * an org holding keys for both providers needs a deterministic answer rather
 * than a coin flip. Deterministic matters more than clever: a resumed run must
 * reach the provider its first attempt billed, and a draft's refine must reach
 * the provider its generation billed. A generation billed to Google and a
 * refine of the same draft billed to OpenRouter is a bill nobody can explain.
 *
 * It lives here, in the package both apps already depend on, because the rule
 * is an ORDERING and not a query. `ai_credentials` has a unique index on
 * `(org_id, provider)` and there are exactly two providers, so an org has at
 * most two rows: both apps can select all of them and sort. Two copies of an
 * `ORDER BY` held together by a test in each package would be two tests that
 * stay green when the OTHER copy changes — which is how two things that must
 * agree stop agreeing.
 *
 * Comparison notes, both of which keep this identical to the SQL it replaced:
 *  - times are compared in milliseconds, not at any coarser grain — two keys
 *    saved in one sitting are seconds apart, and `created_at` is `defaultNow()`;
 *  - providers are compared with `<`, i.e. by code unit, NOT `localeCompare`,
 *    whose answer depends on the runtime's locale. Every member of
 *    `AI_PROVIDERS` is lowercase ASCII, so code-unit order is what Postgres's
 *    `ORDER BY provider` gives under any collation.
 */
export function compareCredentialOrder(a: CredentialOrderRow, b: CredentialOrderRow): number {
  const byAge = a.createdAt.getTime() - b.createdAt.getTime();
  if (byAge !== 0) return byAge;
  if (a.provider === b.provider) return 0;
  return a.provider < b.provider ? -1 : 1;
}

/**
 * The one credential the org uses, or `undefined` if it has none.
 *
 * A scan rather than `rows.sort()[0]`: sorting in place would reorder an array
 * the caller still holds, and there is nothing to gain from ordering rows
 * nobody will look at. Ties keep the earlier element, which the unique index on
 * `(org_id, provider)` makes unreachable anyway — no two rows of one org can
 * compare equal.
 */
export function preferredCredential<T extends CredentialOrderRow>(
  rows: readonly T[],
): T | undefined {
  return rows.reduce<T | undefined>(
    (best, candidate) =>
      best === undefined || compareCredentialOrder(candidate, best) < 0 ? candidate : best,
    undefined,
  );
}
