import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { AiCredential, UsageRecord } from "@pubrick/ai";
import { schema } from "@pubrick/db";
import {
  type AiCredentialTestResult,
  type AiCredentialUpsert,
  type AiProviderId,
  type CostSummary,
  costTotals,
  decryptJson,
  encryptJson,
  isMalformedStoredAiCredential,
  isUnreadableCiphertext,
  MALFORMED_STORED_AI_CREDENTIAL_MESSAGE,
  MAX_TEST_CALLS_PER_HOUR,
  parseStoredAiCredential,
  preferredCredential,
  summarizeCost,
  toLedgerCostUsd,
  UNREADABLE_CREDENTIALS_MESSAGE,
} from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
import { notFound } from "../api-error";
import { db } from "../db";
import { env } from "../env";
import { AiCredentialProbe } from "./ai-credentials.probe";

/**
 * Explicit allowlist, and note what is NOT in it: `credentialsEncrypted`.
 * Same rule as `ChannelsRepository` — a `select()` silently widens the moment a
 * column is added, and the column this table exists for is a secret. `id` is
 * absent too: the resource is addressed by provider, so nothing needs it.
 */
const PUBLIC_COLUMNS = {
  provider: schema.aiCredentials.provider,
  defaultModel: schema.aiCredentials.defaultModel,
  updatedAt: schema.aiCredentials.updatedAt,
};

/** The `step` a ledger row gets when the call belongs to no run. */
const TEST_STEP = "test";

/**
 * The window `MAX_TEST_CALLS_PER_HOUR` is counted over.
 *
 * A literal interval rather than a computed `Date`: the comparison happens in
 * Postgres against `usage_ledger.created_at`, which is `timestamp` WITHOUT time
 * zone and is written by the database's own `now()`. Handing it a JavaScript
 * `Date` from an api replica running in, say, Europe/Moscow would shift the
 * window by the offset — the same defect the worker's lease arithmetic
 * documents at length, and here it would either wave every request through or
 * refuse every one of them.
 */
const TEST_BUDGET_WINDOW = sql`interval '1 hour'`;

@Injectable()
export class AiCredentialsRepository {
  private readonly logger = new Logger(AiCredentialsRepository.name);

  constructor(private readonly probe: AiCredentialProbe) {}

  list(orgId: string) {
    return db
      .select(PUBLIC_COLUMNS)
      .from(schema.aiCredentials)
      .where(eq(schema.aiCredentials.orgId, orgId));
  }

  async upsert(orgId: string, data: AiCredentialUpsert) {
    const credentialsEncrypted = encryptJson({ apiKey: data.apiKey }, env.APP_ENCRYPTION_KEY);
    const defaultModel = data.defaultModel ?? null;
    const rows = await db
      .insert(schema.aiCredentials)
      .values({ orgId, provider: data.provider, credentialsEncrypted, defaultModel })
      .onConflictDoUpdate({
        target: [schema.aiCredentials.orgId, schema.aiCredentials.provider],
        // `updatedAt` is deliberately absent: drizzle's `buildUpdateSet` — the
        // same builder `.update()` uses — adds every column carrying an
        // `$onUpdate`, whether or not it appears here (pg-core/dialect.js:100-109,
        // reached from insert.js:149). Setting it by hand would be a no-op
        // dressed up as a safeguard. The e2e backdates the row and asserts the
        // date moves, so a drizzle upgrade that changed this fails there.
        set: { credentialsEncrypted, defaultModel },
      })
      .returning(PUBLIC_COLUMNS);
    return rows[0];
  }

  /**
   * Remove a key, and fail the runs that were waiting to use it.
   *
   * A `queued` run left alone would be picked up minutes later and die on a
   * provider 401 — an error message about an HTTP status, for a cause the user
   * created deliberately and can read plainly here. Failing it now, in the same
   * transaction, with a message that names the missing key is the difference
   * between "the run failed" and "the run failed because you removed the
   * OpenRouter key".
   *
   * All of the org's queued runs, not a subset: nothing on a run records which
   * provider it intends to use (increment 1 has no per-run model choice), so
   * "the runs that needed THIS key" is not a question the data can answer. The
   * honest options are to fail them all with a nameable reason or to let them
   * fail later with an unreadable one, and a failed run is one click from Try
   * again once a key is back.
   */
  async delete(orgId: string, provider: AiProviderId) {
    return db.transaction(async (tx) => {
      const rows = await tx
        .delete(schema.aiCredentials)
        .where(
          and(eq(schema.aiCredentials.orgId, orgId), eq(schema.aiCredentials.provider, provider)),
        )
        .returning({ provider: schema.aiCredentials.provider });
      if (rows.length === 0) {
        throw notFound("ai_credential_not_found", "No API key stored for this provider");
      }

      const failed = await tx
        .update(schema.pipelineRuns)
        .set({
          status: "failed",
          error: `The ${provider} API key was removed while this run was queued. Add a key in Settings, then try again.`,
        })
        .where(and(eq(schema.pipelineRuns.orgId, orgId), eq(schema.pipelineRuns.status, "queued")))
        .returning({ id: schema.pipelineRuns.id });

      return { deleted: true, failedRuns: failed.length };
    });
  }

  /**
   * The org's spend to date, under the three display rules.
   *
   * Summed by `org_id` alone. `run_id`, `channel_id` and the runs' own
   * `content_item_id` are all `ON DELETE SET NULL` precisely so that deleting a
   * brand, a run or a channel cannot erase the record of money already spent —
   * which means a join through any of them would quietly drop exactly those
   * rows, and the org's total would shrink every time it tidied up.
   *
   * The counts are not decoration: `SUM()` skips null costs, so without them a
   * ledger full of unpriced calls renders a confident, precise, too-small
   * number.
   *
   * The three buckets below are `costTotals()`'s, transcribed into SQL and kept
   * word for word in step with it — the doc comment on `cost-display.ts` is the
   * single statement of the rule, and two code paths answering one question is
   * how a total starts depending on which screen asked. `PRICED` is
   * `cost_usd IS NOT NULL AND cost_source <> 'unknown'`; anything else that
   * counted tokens OR whose outcome is `unknown` is unpriced; anything else (a
   * 429 the provider refused before generating) is ignored, because its cost is
   * known to be zero and the ledger is lifetime — one blip must not stamp "≥"
   * on an org's total forever.
   *
   * A bucket rule pinned in one of the two readers and not the other is exactly
   * the seam the outcome clause came from, so the e2e drives THIS path over the
   * same rows `cost-display.test.ts` folds in memory.
   *
   * PLUS THE CALLS THAT NEVER BECAME ROWS. A ledger insert is allowed to fail
   * without destroying the text the org has already paid for, and when it does
   * the worker counts the loss on the run instead
   * (`pipeline_runs.unrecorded_calls`, migration 0013). Those calls are in no
   * bucket, because the buckets partition rows and there is no row — and they
   * are exactly what this figure was silently missing: a call the ledger
   * refused subtracted itself from the total and left the label reading
   * `exact`. Measured before this read them: one priced call and three lost
   * ones rendered `$0.007875`, exact, against a bill four calls long.
   *
   * They are NOT a fourth bucket and NOT a fourth display rule, on purpose. The
   * rules decide what a reader may conclude from the figure, and an unrecorded
   * call licenses the same conclusion as an unpriced row: money left, no total
   * names the amount, so the figure is a floor and the count says how many
   * calls stand outside it. "≥ $X (N calls unpriced)" is true of both, and it
   * is the one sentence the reader can act on. That an unrecorded call is MORE
   * unknown than an unpriced one — no tokens, no step, no timestamp — is a
   * fact about the run, and the run's receipt is where it is said, per run and
   * in those words (`Runs.unrecordedCalls` in the web). A second symbol on the
   * org's total for it would tell the reader to do nothing different.
   *
   * Summed by `org_id` over the runs, like the ledger and for the same reason:
   * a run's `brand_id` cascades, and a join through the brand would drop the
   * losses of every brand the org has since deleted. `SUM()` skips NULL, which
   * is correct here rather than a trap: NULL is a run from before the counter,
   * and nothing can be counted from a row that holds no count — the org's
   * total may still be understated by losses on those runs, and there is no
   * number anywhere that could say by how much.
   */
  async spend(orgId: string): Promise<CostSummary> {
    const priced = sql`${schema.usageLedger.costUsd} is not null and ${schema.usageLedger.costSource} <> 'unknown'`;
    const countedTokens = sql`${schema.usageLedger.inputTokens} + ${schema.usageLedger.outputTokens} > 0`;
    // `is not distinct from`, not `=`: the column is NULL on every row written
    // before it existed, and `NULL = 'unknown'` is NULL rather than false. That
    // happens to give the same answer where this expression sits today — inside
    // an OR, under an AND, where NULL and false are indistinguishable to
    // `count(*) filter` — and stops doing so the moment it is negated or moved
    // out. This form is two-valued wherever it stands: a NULL outcome reads as
    // `completed`, which is the meaning those rows already had.
    const outcomeUnknown = sql`${schema.usageLedger.outcome} is not distinct from 'unknown'`;
    const rows = await db
      .select({
        usd: sql<string>`coalesce(sum(${schema.usageLedger.costUsd}) filter (where ${priced}), 0)`,
        unpricedCalls: sql<string>`count(*) filter (where not (${priced}) and (${countedTokens} or ${outcomeUnknown}))`,
        estimatedCalls: sql<string>`count(*) filter (where ${priced} and ${schema.usageLedger.costSource} = 'price_table')`,
      })
      .from(schema.usageLedger)
      .where(eq(schema.usageLedger.orgId, orgId));

    const lost = await db
      .select({
        unrecordedCalls: sql<string>`coalesce(sum(${schema.pipelineRuns.unrecordedCalls}), 0)`,
      })
      .from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.orgId, orgId));

    const row = rows[0];
    // An aggregate over zero rows still returns one row; this guards the type,
    // not a case Postgres produces.
    if (!row) return summarizeCost({ usd: 0, unpricedCalls: 0, estimatedCalls: 0 });

    return summarizeCost({
      usd: Number(row.usd),
      unpricedCalls: Number(row.unpricedCalls) + Number(lost[0]?.unrecordedCalls ?? 0),
      estimatedCalls: Number(row.estimatedCalls),
    });
  }

  /**
   * Prove the key, the model id and structured-output support in one act.
   *
   * Never cached, by construction: this makes the call every time it is asked.
   * A key that worked yesterday is not evidence it works now — it can be
   * revoked, run out of credit, or lose access to the model it names — and a
   * cached green tick would be a claim we did not check.
   */
  async test(orgId: string, provider: AiProviderId): Promise<AiCredentialTestResult> {
    // BEFORE the decrypt and before the provider, because refusing after either
    // of those would be refusing after the cost. This is the whole of the limit:
    // the endpoint's own membership guard is the only other thing between a
    // member and the organisation's key.
    if (await this.overTestBudget(orgId)) return { ok: false, reason: "too_many_tests" };

    let credential: AiCredential;
    try {
      credential = await this.getDecrypted(orgId, provider);
    } catch (error) {
      // "No key stored" is genuinely not-found and stays a 404. A blob that
      // will not decrypt is not: the row exists, the screen is still listing it,
      // and the honest answer to "test this key" is a verdict about the key —
      // not a 500 carrying a crypto stack trace to a browser. It happens for a
      // real reason (APP_ENCRYPTION_KEY rotated under a stored row).
      if (error instanceof NotFoundException) throw error;
      // Two events share the verdict and NOT the log line. The screen's sentence
      // for `unreadable_key` — "could not be read, save it again" — is true of
      // both and names the one thing the user can do about either; what differs
      // is the operator's half, and it goes where the operator reads. A blob no
      // ring key opens points at the ring. A blob that opened and holds no key
      // points at the row, and the ring is explicitly NOT the problem: this
      // used to be reported as the first, sending someone to rotate a key that
      // was fine.
      if (isUnreadableCiphertext(error)) {
        this.logger.warn(
          `Stored ${provider} key for org ${orgId}: ${UNREADABLE_CREDENTIALS_MESSAGE}`,
        );
        return { ok: false, reason: "unreadable_key" };
      }
      if (isMalformedStoredAiCredential(error)) {
        this.logger.error(
          `Stored ${provider} key for org ${orgId}: ${MALFORMED_STORED_AI_CREDENTIAL_MESSAGE}`,
        );
        return { ok: false, reason: "unreadable_key" };
      }
      // Anything else — a malformed ring, a bug in this method — is a broken
      // instance, not a verdict about the user's key, and stays the 500 it is.
      // Same rule `ChannelsRepository.getDecryptedCredentials` follows.
      throw error;
    }

    const outcome = await this.probe.run(credential);

    // Before the verdict, and for the failed verdict too: the provider counts
    // tokens before it knows whether we could parse the answer, so a failed
    // Test can still have cost money. A ledger that only records successes
    // under-reports spend.
    await this.recordUsage(orgId, outcome.records);

    if (!outcome.ok) return { ok: false, reason: outcome.reason };
    return {
      ok: true,
      modelId: outcome.modelId,
      cost: summarizeCost(costTotals(outcome.records)),
    };
  }

  /**
   * Has this org used up its hourly allowance of billed test calls?
   *
   * COUNTED FROM THE LEDGER the calls themselves wrote, rather than from a
   * counter of presses. Three things follow, and each is the reason for the
   * choice:
   *
   * - the number is the same for every api replica and survives a restart. An
   *   in-process bucket is one budget PER REPLICA and a fresh budget after every
   *   deploy, which is a limit an attacker can wait out;
   * - a press that cost two physical calls (the structured-output repair retry)
   *   consumes two, because the ledger wrote two. The thing bounded is money,
   *   not clicks;
   * - a Test that spent nothing consumes nothing. An unreadable key never
   *   reaches a provider and writes no row, so a user whose key blob is broken
   *   can keep pressing Test while they fix it and never meet this refusal.
   *
   * The race is real and bounded: two presses that read the count at the same
   * instant can both pass. The overshoot is the concurrency, not a multiple of
   * the limit, and `SELECT … FOR UPDATE` over a rate window would serialise
   * every press in the deployment behind one lock to save a call worth a tenth
   * of a cent.
   *
   * `>=`, not `>`: the count is of calls ALREADY MADE, so a count that has
   * reached the limit means the allowance is spent, not that one more is owed.
   */
  private async overTestBudget(orgId: string): Promise<boolean> {
    const rows = await db
      .select({ calls: sql<string>`count(*)` })
      .from(schema.usageLedger)
      .where(
        and(
          eq(schema.usageLedger.orgId, orgId),
          eq(schema.usageLedger.step, TEST_STEP),
          sql`${schema.usageLedger.createdAt} > now() - ${TEST_BUDGET_WINDOW}`,
        ),
      );
    // `count(*)` over zero rows still returns one row holding 0; this guards the
    // type, not a case Postgres produces.
    return Number(rows[0]?.calls ?? 0) >= MAX_TEST_CALLS_PER_HOUR;
  }

  /**
   * Internal use only (the Test action). Never expose through a controller —
   * this and `credential` are the only methods that return the key.
   */
  async getDecrypted(orgId: string, provider: AiProviderId): Promise<AiCredential> {
    const rows = await db
      .select({
        credentialsEncrypted: schema.aiCredentials.credentialsEncrypted,
        defaultModel: schema.aiCredentials.defaultModel,
      })
      .from(schema.aiCredentials)
      .where(
        and(eq(schema.aiCredentials.orgId, orgId), eq(schema.aiCredentials.provider, provider)),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("ai_credential_not_found", "No API key stored for this provider");
    return this.decrypt(provider, row);
  }

  /**
   * The org's key for a call that names no provider — an editor-side model call,
   * where the user chose text to work on and not a vendor to bill.
   *
   * The choice is `preferredCredential` (`@pubrick/shared`): the oldest key the
   * org configured, tie-broken by provider name. `GenerateRepository.credential`
   * sorts with the same function over the same rows, and that is the whole
   * point — a draft generated against Google and refined against OpenRouter is a
   * bill the user cannot explain, and nothing on a run or a draft records which
   * vendor produced it.
   *
   * One ordering over one unchanged set of rows is the whole of the guarantee:
   * because nothing records the vendor, changing the set changes the answer for
   * work already under way. `preferredCredential` states the limit; the case
   * that reaches it is a `running` run whose key is deleted.
   *
   * Returns `undefined` for "this org has no key", following the worker's
   * contract rather than `getDecrypted`'s `NotFoundException`. The two differ
   * honestly: asking for a *named* provider that is not stored is a 404 about a
   * resource the caller addressed, while asking for "whatever this org uses" is
   * a question with a legitimate empty answer that the caller has to render.
   */
  async credential(orgId: string): Promise<AiCredential | undefined> {
    const rows = await db
      .select({
        provider: schema.aiCredentials.provider,
        createdAt: schema.aiCredentials.createdAt,
        credentialsEncrypted: schema.aiCredentials.credentialsEncrypted,
        defaultModel: schema.aiCredentials.defaultModel,
      })
      .from(schema.aiCredentials)
      .where(eq(schema.aiCredentials.orgId, orgId));
    const row = preferredCredential(rows);
    if (!row) return undefined;
    return this.decrypt(row.provider, row);
  }

  /**
   * The decrypt, in one place, because both readers of the secret column reach
   * it through here. A `decryptJson` per caller is how one of them ends up
   * reading a different env var, or forgetting that the blob can fail to open
   * at all — which `test` classifies as `unreadable_key` off the throw.
   *
   * Throws one of two marked errors, or whatever else the decrypt threw:
   * `UnreadableCiphertextError` when no ring key opens the blob, and
   * `MalformedStoredAiCredentialError` when one did and the plaintext is not
   * `{ apiKey }`. The parse is not optional: without it a row holding some other
   * JSON handed `apiKey: undefined` to the probe, which made a live call with it.
   */
  private decrypt(
    provider: AiProviderId,
    row: { credentialsEncrypted: string; defaultModel: string | null },
  ): AiCredential {
    const { apiKey } = parseStoredAiCredential(
      decryptJson(row.credentialsEncrypted, env.APP_ENCRYPTION_KEY),
    );
    return { provider, apiKey, defaultModel: row.defaultModel };
  }

  /**
   * One ledger row per physical call, with no run to attribute them to.
   *
   * `run_id` is nullable for exactly this: money spent outside a run is still
   * the org's money, and it belongs in the same column the Settings total sums.
   */
  private async recordUsage(orgId: string, records: readonly UsageRecord[]): Promise<void> {
    if (records.length === 0) return;
    try {
      await db.insert(schema.usageLedger).values(
        records.map((record) => ({
          orgId,
          runId: null,
          step: TEST_STEP,
          channelId: null,
          attempt: record.attempt,
          provider: record.provider,
          modelId: record.modelId,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          cachedInputTokens: record.cachedInputTokens,
          reasoningTokens: record.reasoningTokens,
          // `numeric(12,6)` is a string column in drizzle, and the conversion is
          // not `String(cost)`: see `toLedgerCostUsd`, which also floors a real
          // sub-micro-dollar cost so a billed call never stores 0.000000.
          costUsd: toLedgerCostUsd(record.costUsd),
          costSource: record.costSource,
          status: record.status,
          // What became of the round trip. A zero-token row is written by a 429
          // AND by a call lost after dispatch; this is the only column that
          // says which, and `spend()` reads it to decide whether the total is a
          // floor.
          outcome: record.outcome,
          responseMs: record.responseMs,
          keyOwnership: "byok" as const,
        })),
      );
    } catch (error) {
      // Losing the record of a billed call is bad. Throwing away the answer we
      // already paid for as well is strictly worse — and a 500 here would do
      // both, on a call the provider has already charged for. Same rule the
      // publisher follows for a delivered post it could not record, and the same
      // rule `generateStructured`'s own `onUsageError` follows: shout, keep the
      // result. The message names what the org's total is now missing.
      this.logger.error(
        `USAGE RECORDING FAILED: ${records.length} billed ${records[0]?.provider} call(s) could not be written to the ledger — this org's spend is understated by them. ` +
          `orgId=${orgId} step=${TEST_STEP} error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
