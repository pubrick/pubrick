import { Injectable, NotFoundException } from "@nestjs/common";
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
  summarizeCost,
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
        // `updatedAt` is set by hand: drizzle's `$onUpdate` fires for `.update()`
        // only, so an upsert that replaced a key would otherwise still report
        // the date the key was FIRST saved — the one date this row is for.
        set: { credentialsEncrypted, defaultModel, updatedAt: new Date() },
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
   * number. See `summarizeCost`.
   */
  async spend(orgId: string): Promise<CostSummary> {
    const rows = await db
      .select({
        usd: sql<string>`coalesce(sum(${schema.usageLedger.costUsd}), 0)`,
        unpricedCalls: sql<string>`count(*) filter (where ${schema.usageLedger.costSource} = 'unknown' or ${schema.usageLedger.costUsd} is null)`,
        estimatedCalls: sql<string>`count(*) filter (where ${schema.usageLedger.costSource} = 'price_table' and ${schema.usageLedger.costUsd} is not null)`,
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
    const credential = await this.getDecrypted(orgId, provider);
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
   * Internal use only (the generation worker and the Test action). Never expose
   * through a controller — this is the one method that returns the key.
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
        // numeric(12,6) is a string column in drizzle; `toFixed(6)` stores the
        // exact value the price table computed instead of whatever
        // `String(number)` decides to print.
        costUsd: record.costUsd === null ? null : record.costUsd.toFixed(6),
        costSource: record.costSource,
        status: record.status,
        responseMs: record.responseMs,
        keyOwnership: "byok" as const,
      })),
    );
  }
}
