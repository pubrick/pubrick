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
  preferredCredential,
  summarizeCost,
  toLedgerCostUsd,
} from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
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
      if (rows.length === 0) throw new NotFoundException("No API key stored for this provider");

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
   * counted tokens is unpriced; anything else that did not (a 429 rejected
   * before the provider counted anything) is ignored, because its cost is known
   * to be zero and the ledger is lifetime — one blip must not stamp "≥" on an
   * org's total forever.
   */
  async spend(orgId: string): Promise<CostSummary> {
    const priced = sql`${schema.usageLedger.costUsd} is not null and ${schema.usageLedger.costSource} <> 'unknown'`;
    const countedTokens = sql`${schema.usageLedger.inputTokens} + ${schema.usageLedger.outputTokens} > 0`;
    const rows = await db
      .select({
        usd: sql<string>`coalesce(sum(${schema.usageLedger.costUsd}) filter (where ${priced}), 0)`,
        unpricedCalls: sql<string>`count(*) filter (where not (${priced}) and ${countedTokens})`,
        estimatedCalls: sql<string>`count(*) filter (where ${priced} and ${schema.usageLedger.costSource} = 'price_table')`,
      })
      .from(schema.usageLedger)
      .where(eq(schema.usageLedger.orgId, orgId));

    const row = rows[0];
    // An aggregate over zero rows still returns one row; this guards the type,
    // not a case Postgres produces.
    if (!row) return summarizeCost({ usd: 0, unpricedCalls: 0, estimatedCalls: 0 });

    return summarizeCost({
      usd: Number(row.usd),
      unpricedCalls: Number(row.unpricedCalls),
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
      return { ok: false, reason: "unreadable_key" };
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
    if (!row) throw new NotFoundException("No API key stored for this provider");
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
   */
  private decrypt(
    provider: AiProviderId,
    row: { credentialsEncrypted: string; defaultModel: string | null },
  ): AiCredential {
    const { apiKey } = decryptJson<{ apiKey: string }>(
      row.credentialsEncrypted,
      env.APP_ENCRYPTION_KEY,
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
