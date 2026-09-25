import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import {
  buildPaidReplyRequest,
  countPaidReplyTokens,
  PAID_REPLY_MAX_OUTPUT_TOKENS,
  PAID_REPLY_MODEL_ID,
  type PaidReplyGeneration,
  type PaidReplyRequest,
  priceFor,
} from "@pubrick/ai";
import { admitPaidReplyAttempt, type PaidReplyTransaction, schema } from "@pubrick/db";
import {
  decryptJson,
  encryptJson,
  isPublicTelegramPostUrl,
  PAID_REPLY_ANALYSIS_QUEUE,
  type PaidReplyAnalysisJob,
  paidReplyAnalysisJobOptions,
  parseStoredAiCredential,
} from "@pubrick/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import { z } from "zod";
import { db } from "../db";
import { env } from "../env";

type Tx = PaidReplyTransaction;
type Kind = "source_comment" | "publication_comment";
type Target = {
  orgId: string;
  brandId: string;
  kind: Kind;
  id: string;
  version: string;
  automatic: boolean;
};
type Snapshot = { target: Target; title: string; comments: string[]; checkedAt: Date };
const encryptedRequestSchema = z.object({
  modelId: z.literal(PAID_REPLY_MODEL_ID),
  body: z.string().min(1),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
  sampleSize: z.number().int().min(1).max(30),
});
const publicStoryUrl = /^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\/[1-9]\d*$/;
const BATCH_SIZE = 20;

function priceIdentity(at: Date): string | null {
  const rate = priceFor("google", PAID_REPLY_MODEL_ID, at);
  return rate ? createHash("sha256").update(JSON.stringify(rate)).digest("hex") : null;
}

function maximumUsd(allowance: number, at: Date): string | null {
  const rate = priceFor("google", PAID_REPLY_MODEL_ID, at);
  if (!rate) return null;
  const tier =
    rate.longContext && allowance > rate.longContext.fromInputTokens ? rate.longContext : rate;
  const dollars =
    (allowance * tier.inputPerMTok + PAID_REPLY_MAX_OUTPUT_TOKENS * tier.outputPerMTok) / 1_000_000;
  return (Math.max(1, Math.ceil(dollars * 1_000_000)) / 1_000_000).toFixed(6);
}

function safeKey(encrypted: string | undefined): string | null {
  if (!encrypted) return null;
  try {
    return parseStoredAiCredential(decryptJson(encrypted, env.APP_ENCRYPTION_KEY)).apiKey;
  } catch {
    return null;
  }
}

/** All target locks follow org -> brand -> source/story or adaptation/channel/item/publication -> sample. */
async function lockTarget(tx: Tx, target: Target): Promise<{ checkedAt: Date } | null> {
  if (target.kind === "source_comment") {
    const [hint] = await tx
      .select({ sourceId: schema.newsItems.sourceId })
      .from(schema.newsItems)
      .where(and(eq(schema.newsItems.orgId, target.orgId), eq(schema.newsItems.id, target.id)));
    if (!hint) return null;
    const [source] = await tx
      .select({ id: schema.newsSources.id })
      .from(schema.newsSources)
      .where(
        and(
          eq(schema.newsSources.id, hint.sourceId),
          eq(schema.newsSources.orgId, target.orgId),
          eq(schema.newsSources.brandId, target.brandId),
          eq(schema.newsSources.kind, "telegram"),
          eq(schema.newsSources.isActive, true),
        ),
      )
      .for("share");
    if (!source) return null;
    const [item] = await tx
      .select({
        checkedAt: schema.newsItems.commentsCheckedAt,
        url: schema.newsItems.url,
      })
      .from(schema.newsItems)
      .where(
        and(
          eq(schema.newsItems.id, target.id),
          eq(schema.newsItems.orgId, target.orgId),
          eq(schema.newsItems.brandId, target.brandId),
          eq(schema.newsItems.sourceId, source.id),
          eq(schema.newsItems.commentsSampleVersion, target.version),
          sql`${schema.newsItems.dismissedAt} IS NULL`,
          ...(target.automatic
            ? [
                eq(schema.newsItems.relevanceStatus, "scored"),
                sql`${schema.newsItems.relevanceScore} >= 0.7`,
              ]
            : []),
        ),
      )
      .for("share");
    if (!item?.checkedAt || !publicStoryUrl.test(item.url)) return null;
    return { checkedAt: item.checkedAt };
  }
  const [hint] = await tx
    .select({
      adaptationId: schema.publications.adaptationId,
      channelId: schema.publications.channelId,
    })
    .from(schema.publications)
    .where(and(eq(schema.publications.orgId, target.orgId), eq(schema.publications.id, target.id)));
  if (!hint?.adaptationId || !hint.channelId) return null;
  const [adaptation] = await tx
    .select({ itemId: schema.adaptations.contentItemId })
    .from(schema.adaptations)
    .where(
      and(
        eq(schema.adaptations.orgId, target.orgId),
        eq(schema.adaptations.id, hint.adaptationId),
        eq(schema.adaptations.channelId, hint.channelId),
      ),
    )
    .for("share");
  if (!adaptation) return null;
  const [channel] = await tx
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(
      and(
        eq(schema.channels.orgId, target.orgId),
        eq(schema.channels.id, hint.channelId),
        eq(schema.channels.brandId, target.brandId),
        eq(schema.channels.platform, "telegram"),
      ),
    )
    .for("share");
  if (!channel) return null;
  const [item] = await tx
    .select({ id: schema.contentItems.id })
    .from(schema.contentItems)
    .where(
      and(
        eq(schema.contentItems.orgId, target.orgId),
        eq(schema.contentItems.id, adaptation.itemId),
        eq(schema.contentItems.brandId, target.brandId),
      ),
    )
    .for("share");
  if (!item) return null;
  const [publication] = await tx
    .select({ url: schema.publications.externalUrl, externalId: schema.publications.externalId })
    .from(schema.publications)
    .where(
      and(
        eq(schema.publications.orgId, target.orgId),
        eq(schema.publications.id, target.id),
        eq(schema.publications.adaptationId, hint.adaptationId),
        eq(schema.publications.channelId, channel.id),
        eq(schema.publications.status, "published"),
      ),
    )
    .for("share");
  if (!publication || !isPublicTelegramPostUrl(publication.url, publication.externalId))
    return null;
  const [sample] = await tx
    .select({ checkedAt: schema.publicationCommentSamples.checkedAt })
    .from(schema.publicationCommentSamples)
    .where(
      and(
        eq(schema.publicationCommentSamples.orgId, target.orgId),
        eq(schema.publicationCommentSamples.brandId, target.brandId),
        eq(schema.publicationCommentSamples.publicationId, target.id),
        eq(schema.publicationCommentSamples.sampleVersion, target.version),
      ),
    )
    .for("share");
  return sample?.checkedAt ? { checkedAt: sample.checkedAt } : null;
}

async function readSnapshot(target: Target): Promise<Snapshot | null> {
  if (target.kind === "source_comment") {
    const [item] = await db
      .select({
        title: schema.newsItems.title,
        checkedAt: schema.newsItems.commentsCheckedAt,
        version: schema.newsItems.commentsSampleVersion,
      })
      .from(schema.newsItems)
      .where(and(eq(schema.newsItems.orgId, target.orgId), eq(schema.newsItems.id, target.id)));
    if (!item?.checkedAt || item.version !== target.version) return null;
    const rows = await db
      .select({ body: schema.newsComments.body })
      .from(schema.newsComments)
      .where(
        and(eq(schema.newsComments.orgId, target.orgId), eq(schema.newsComments.itemId, target.id)),
      )
      .orderBy(desc(schema.newsComments.publishedAt), desc(schema.newsComments.id))
      .limit(30);
    return rows.length
      ? {
          target,
          title: item.title,
          comments: rows.map((row) => row.body),
          checkedAt: item.checkedAt,
        }
      : null;
  }
  const [sample] = await db
    .select({
      checkedAt: schema.publicationCommentSamples.checkedAt,
      version: schema.publicationCommentSamples.sampleVersion,
      title: schema.contentItems.title,
    })
    .from(schema.publicationCommentSamples)
    .innerJoin(
      schema.publications,
      eq(schema.publications.id, schema.publicationCommentSamples.publicationId),
    )
    .innerJoin(schema.adaptations, eq(schema.adaptations.id, schema.publications.adaptationId))
    .innerJoin(schema.contentItems, eq(schema.contentItems.id, schema.adaptations.contentItemId))
    .where(
      and(
        eq(schema.publicationCommentSamples.orgId, target.orgId),
        eq(schema.publicationCommentSamples.brandId, target.brandId),
        eq(schema.publicationCommentSamples.publicationId, target.id),
      ),
    );
  if (!sample?.checkedAt || sample.version !== target.version) return null;
  const rows = await db
    .select({ body: schema.publicationComments.body })
    .from(schema.publicationComments)
    .where(
      and(
        eq(schema.publicationComments.orgId, target.orgId),
        eq(schema.publicationComments.publicationId, target.id),
      ),
    )
    .orderBy(desc(schema.publicationComments.publishedAt), desc(schema.publicationComments.id))
    .limit(30);
  return rows.length
    ? {
        target,
        title: sample.title ?? "",
        comments: rows.map((row) => row.body),
        checkedAt: sample.checkedAt,
      }
    : null;
}

@Injectable()
export class PaidReplyRepository {
  /** A bounded pass over explicit handoffs, never a scan over historical samples. */
  async reconcile(boss: PgBoss, start: Date): Promise<number> {
    const handoffs = await db
      .select()
      .from(schema.paidReplyAnalysisHandoffs)
      .where(
        and(
          eq(schema.paidReplyAnalysisHandoffs.status, "pending"),
          sql`${schema.paidReplyAnalysisHandoffs.createdAt} >= ${start}`,
        ),
      )
      .orderBy(
        asc(schema.paidReplyAnalysisHandoffs.updatedAt),
        asc(schema.paidReplyAnalysisHandoffs.id),
      )
      .limit(BATCH_SIZE);
    let admitted = 0;
    for (const handoff of handoffs) {
      const target: Target = {
        orgId: handoff.orgId,
        brandId: handoff.brandId,
        kind: handoff.targetKind,
        id: handoff.targetId,
        version: handoff.sampleVersion,
        automatic: true,
      };
      const snapshot = await readSnapshot(target);
      if (!snapshot) {
        await this.finishHandoff(handoff.id, "canceled", "sample_changed");
        continue;
      }
      const [credential] = await db
        .select({ encrypted: schema.aiCredentials.credentialsEncrypted })
        .from(schema.aiCredentials)
        .where(
          and(
            eq(schema.aiCredentials.orgId, target.orgId),
            eq(schema.aiCredentials.provider, "google"),
          ),
        );
      const apiKey = safeKey(credential?.encrypted);
      if (!apiKey) {
        await this.finishHandoff(handoff.id, "blocked", "no_key");
        continue;
      }
      let request: PaidReplyRequest;
      let allowance: number;
      try {
        request = buildPaidReplyRequest(snapshot);
        ({ allowance } = await countPaidReplyTokens(request, apiKey));
      } catch (error) {
        await this.finishHandoff(
          handoff.id,
          "blocked",
          error instanceof Error && error.message === "request_too_large"
            ? "request_too_large"
            : "unknown_spend",
        );
        continue;
      }
      const at = new Date();
      const identity = priceIdentity(at);
      const reservation = maximumUsd(allowance, at);
      if (!reservation || !identity) {
        await this.finishHandoff(handoff.id, "blocked", "unpriced_model");
        continue;
      }
      try {
        const outcome = await admitPaidReplyAttempt(db, {
          ...target,
          targetKind: target.kind,
          targetId: target.id,
          sampleVersion: target.version,
          sampleCheckedAt: snapshot.checkedAt,
          origin: "automatic",
          promptDigest: request.digest,
          promptEncrypted: encryptJson(request, env.APP_ENCRYPTION_KEY),
          sampleSize: request.sampleSize,
          modelId: request.modelId,
          priceWindow: identity,
          reservedMaxUsd: reservation,
          freeRevision: handoff.freeRevision,
          paidRevision: handoff.paidRevision,
          orgSettingsRevision: handoff.orgSettingsRevision,
          brandThresholdRevision: handoff.brandThresholdRevision,
          lockAndValidateTarget: async (tx) => {
            if (!(await lockTarget(tx, target))) return false;
            const clock = await tx.execute(
              sql`SELECT (extract(epoch from now()) * 1000)::bigint::text AS at_ms`,
            );
            const dbAt = new Date(Number((clock.rows[0] as { at_ms?: string } | undefined)?.at_ms));
            if (
              !Number.isFinite(dbAt.getTime()) ||
              priceIdentity(dbAt) !== identity ||
              maximumUsd(allowance, dbAt) !== reservation
            )
              return false;
            const [config] = await tx
              .select({
                enabled:
                  target.kind === "source_comment"
                    ? schema.newsCommentCollectionConfigs.enabled
                    : schema.publicationCommentCollectionConfigs.enabled,
                revision:
                  target.kind === "source_comment"
                    ? schema.newsCommentCollectionConfigs.revision
                    : schema.publicationCommentCollectionConfigs.revision,
              })
              .from(
                target.kind === "source_comment"
                  ? schema.newsCommentCollectionConfigs
                  : schema.publicationCommentCollectionConfigs,
              )
              .where(sql`org_id = ${target.orgId} AND brand_id = ${target.brandId}`)
              .for("share");
            const [current] = await tx
              .select({ status: schema.paidReplyAnalysisHandoffs.status })
              .from(schema.paidReplyAnalysisHandoffs)
              .where(eq(schema.paidReplyAnalysisHandoffs.id, handoff.id))
              .for("update");
            return (
              !!config?.enabled &&
              config.revision === handoff.freeRevision &&
              current?.status === "pending"
            );
          },
          onAdmitted: async (tx) => {
            await tx
              .update(schema.paidReplyAnalysisHandoffs)
              .set({ status: "dispatched", updatedAt: sql`now()` })
              .where(eq(schema.paidReplyAnalysisHandoffs.id, handoff.id));
          },
          enqueue: async (tx, attemptId) => {
            const sent = await boss.send(
              PAID_REPLY_ANALYSIS_QUEUE,
              { orgId: target.orgId, attemptId } satisfies PaidReplyAnalysisJob,
              { ...paidReplyAnalysisJobOptions(attemptId, target.orgId), db: fromDrizzle(tx, sql) },
            );
            if (!sent) throw new Error("paid_reply_enqueue_failed");
          },
        });
        if (outcome.status === "admitted") admitted++;
        else if (outcome.status === "existing")
          await this.finishHandoff(handoff.id, "dispatched", null);
        else await this.finishHandoff(handoff.id, "blocked", outcome.reason);
      } catch {
        // The free sample and pending handoff survive a failed paid transaction.
        // Move it behind other pending handoffs before a bounded retry.
        await db
          .update(schema.paidReplyAnalysisHandoffs)
          .set({ updatedAt: sql`now()` })
          .where(
            and(
              eq(schema.paidReplyAnalysisHandoffs.id, handoff.id),
              eq(schema.paidReplyAnalysisHandoffs.status, "pending"),
            ),
          );
      }
    }
    return admitted;
  }

  private async finishHandoff(
    id: string,
    status: "blocked" | "canceled" | "dispatched",
    reason: string | null,
  ): Promise<void> {
    await db
      .update(schema.paidReplyAnalysisHandoffs)
      .set({ status, reason, updatedAt: sql`now()` })
      .where(
        and(
          eq(schema.paidReplyAnalysisHandoffs.id, id),
          eq(schema.paidReplyAnalysisHandoffs.status, "pending"),
        ),
      );
  }

  /** Irreversible transaction commits before the only provider request. */
  async claim(
    job: PaidReplyAnalysisJob,
  ): Promise<{ request: PaidReplyRequest; apiKey: string } | null> {
    const [hint] = await db
      .select()
      .from(schema.paidReplyAnalysisAttempts)
      .where(
        and(
          eq(schema.paidReplyAnalysisAttempts.orgId, job.orgId),
          eq(schema.paidReplyAnalysisAttempts.id, job.attemptId),
        ),
      );
    if (hint?.status !== "queued") return null;
    const target: Target = {
      orgId: hint.orgId,
      brandId: hint.brandId,
      kind: hint.targetKind,
      id: hint.targetId,
      version: hint.sampleVersion,
      automatic: hint.origin === "automatic",
    };
    return db.transaction(async (tx) => {
      const [org] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, job.orgId))
        .for("no key update");
      if (!org) return null;
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, job.orgId), eq(schema.brands.id, hint.brandId)))
        .for("key share");
      const live = brand ? await lockTarget(tx, target) : null;
      let reason: string | null = live ? null : "target_unavailable";
      const [orgSettings] = await tx
        .select()
        .from(schema.organizationPaidReplySettings)
        .where(eq(schema.organizationPaidReplySettings.orgId, job.orgId))
        .for("key share");
      const [paid] = await tx
        .select()
        .from(schema.brandPaidReplySettings)
        .where(
          and(
            eq(schema.brandPaidReplySettings.orgId, job.orgId),
            eq(schema.brandPaidReplySettings.brandId, hint.brandId),
          ),
        )
        .for("key share");
      if (
        !orgSettings ||
        !paid ||
        orgSettings.revision !== hint.orgSettingsRevision ||
        paid.thresholdRevision !== hint.brandThresholdRevision
      )
        reason ??= "setting_changed";
      if (hint.origin === "automatic" && paid) {
        const enabled =
          hint.targetKind === "source_comment" ? paid.sourceEnabled : paid.publicationEnabled;
        const revision =
          hint.targetKind === "source_comment" ? paid.sourceRevision : paid.publicationRevision;
        if (!enabled || revision !== hint.paidRevision) reason ??= "setting_changed";
        const config =
          hint.targetKind === "source_comment"
            ? await tx
                .select({
                  enabled: schema.newsCommentCollectionConfigs.enabled,
                  revision: schema.newsCommentCollectionConfigs.revision,
                })
                .from(schema.newsCommentCollectionConfigs)
                .where(
                  and(
                    eq(schema.newsCommentCollectionConfigs.orgId, job.orgId),
                    eq(schema.newsCommentCollectionConfigs.brandId, hint.brandId),
                  ),
                )
                .for("share")
            : await tx
                .select({
                  enabled: schema.publicationCommentCollectionConfigs.enabled,
                  revision: schema.publicationCommentCollectionConfigs.revision,
                })
                .from(schema.publicationCommentCollectionConfigs)
                .where(
                  and(
                    eq(schema.publicationCommentCollectionConfigs.orgId, job.orgId),
                    eq(schema.publicationCommentCollectionConfigs.brandId, hint.brandId),
                  ),
                )
                .for("share");
        if (!config[0]?.enabled || config[0].revision !== hint.freeRevision)
          reason ??= "setting_changed";
      }
      const [attempt] = await tx
        .select()
        .from(schema.paidReplyAnalysisAttempts)
        .where(
          and(
            eq(schema.paidReplyAnalysisAttempts.orgId, job.orgId),
            eq(schema.paidReplyAnalysisAttempts.id, job.attemptId),
          ),
        )
        .for("update");
      if (attempt?.status !== "queued") return null;
      const bounds = await tx.execute(
        sql`SELECT now() >= ${attempt.dayStartUtc} AND now() < ${attempt.dayEndUtc} AS valid,
          (extract(epoch from now()) * 1000)::bigint::text AS at_ms`,
      );
      const dbAt = new Date(Number((bounds.rows[0] as { at_ms?: string } | undefined)?.at_ms));
      if (
        !(bounds.rows[0] as { valid?: boolean } | undefined)?.valid ||
        orgSettings?.timezone !== attempt.admissionTimezone
      )
        reason ??= "setting_changed";
      if (
        !Number.isFinite(dbAt.getTime()) ||
        priceIdentity(dbAt) !== attempt.priceWindow ||
        attempt.modelId !== PAID_REPLY_MODEL_ID
      )
        reason ??= "unpriced_model";
      if (orgSettings && paid && attempt.dayStartUtc && attempt.dayEndUtc) {
        const spend = await tx.execute(sql`
          WITH ledger AS (
            SELECT coalesce(sum(CASE WHEN outcome = 'refused' THEN 0 ELSE cost_usd END), 0) AS org_cost,
              coalesce(sum(CASE WHEN brand_id IS NULL OR brand_id = ${attempt.brandId}::uuid
                THEN CASE WHEN outcome = 'refused' THEN 0 ELSE cost_usd END ELSE 0 END), 0) AS brand_cost,
              coalesce(bool_or(outcome = 'unknown' OR
                (cost_usd IS NULL AND outcome IS DISTINCT FROM 'refused') OR
                (cost_source = 'unknown' AND outcome IS DISTINCT FROM 'refused')), false) AS unknown
            FROM usage_ledger WHERE org_id = ${job.orgId}
              AND created_at AT TIME ZONE 'UTC' >= ${attempt.dayStartUtc}
              AND created_at AT TIME ZONE 'UTC' < ${attempt.dayEndUtc}
          ), reservations AS (
            SELECT coalesce(sum(reserved_max_usd), 0) AS org_cost,
              coalesce(sum(CASE WHEN brand_id = ${attempt.brandId}::uuid THEN reserved_max_usd ELSE 0 END), 0) AS brand_cost,
              coalesce(bool_or(status = 'unknown'), false) AS unknown
            FROM paid_reply_analysis_attempts WHERE org_id = ${job.orgId}
              AND day_start_utc = ${attempt.dayStartUtc} AND day_end_utc = ${attempt.dayEndUtc}
              AND status IN ('queued', 'dispatching', 'unknown')
          ), markers AS (
            SELECT EXISTS (SELECT 1 FROM analysis_admissions WHERE org_id = ${job.orgId}
              AND unrecorded_calls > 0 AND requested_at >= ${attempt.dayStartUtc}
              AND requested_at < ${attempt.dayEndUtc}) OR
              EXISTS (SELECT 1 FROM pipeline_runs WHERE org_id = ${job.orgId}
              AND unrecorded_calls > 0 AND created_at AT TIME ZONE 'UTC' >= ${attempt.dayStartUtc}
              AND created_at AT TIME ZONE 'UTC' < ${attempt.dayEndUtc}) AS unknown
          )
          SELECT (NOT ledger.unknown AND NOT reservations.unknown AND NOT markers.unknown) AS known,
            ledger.org_cost + reservations.org_cost <= ${orgSettings.dailyThresholdUsd}::numeric AS org_allowed,
            ledger.brand_cost + reservations.brand_cost <= ${paid.dailyThresholdUsd}::numeric AS brand_allowed
          FROM ledger, reservations, markers
        `);
        const verdict = spend.rows[0] as
          | { known: boolean; org_allowed: boolean; brand_allowed: boolean }
          | undefined;
        if (!verdict?.known) reason ??= "unknown_spend";
        else if (!verdict.org_allowed) reason ??= "org_daily_threshold";
        else if (!verdict.brand_allowed) reason ??= "brand_daily_threshold";
      }
      const [keyRow] = await tx
        .select({ encrypted: schema.aiCredentials.credentialsEncrypted })
        .from(schema.aiCredentials)
        .where(
          and(
            eq(schema.aiCredentials.orgId, job.orgId),
            eq(schema.aiCredentials.provider, "google"),
          ),
        )
        .for("share");
      const apiKey = safeKey(keyRow?.encrypted);
      if (!apiKey) reason ??= "no_key";
      let request: PaidReplyRequest | null = null;
      try {
        request = encryptedRequestSchema.parse(
          decryptJson(attempt.promptEncrypted ?? "", env.APP_ENCRYPTION_KEY),
        );
        if (
          request.digest !== attempt.promptDigest ||
          request.sampleSize !== attempt.sampleSize ||
          request.modelId !== attempt.modelId
        )
          request = null;
      } catch {
        request = null;
      }
      if (!request) reason ??= "request_too_large";
      if (reason) {
        await tx
          .update(schema.paidReplyAnalysisAttempts)
          .set({
            status: "canceled",
            failureCode: reason,
            completedAt: sql`now()`,
            promptEncrypted: null,
          })
          .where(eq(schema.paidReplyAnalysisAttempts.id, attempt.id));
        if (attempt.admissionId)
          await tx
            .update(schema.analysisAdmissions)
            .set({ completedAt: sql`now()` })
            .where(eq(schema.analysisAdmissions.id, attempt.admissionId));
        return null;
      }
      await tx
        .update(schema.paidReplyAnalysisAttempts)
        .set({ status: "dispatching", dispatchStartedAt: sql`now()` })
        .where(eq(schema.paidReplyAnalysisAttempts.id, attempt.id));
      return { request: request as PaidReplyRequest, apiKey: apiKey as string };
    });
  }

  /** This commit is awaited by generatePaidReply before a result can be saved. */
  async recordUsage(
    job: PaidReplyAnalysisJob,
    record: Parameters<Parameters<typeof import("@pubrick/ai").generatePaidReply>[2]>[0],
  ): Promise<void> {
    const [attempt] = await db
      .select({
        admissionId: schema.paidReplyAnalysisAttempts.admissionId,
        brandId: schema.paidReplyAnalysisAttempts.brandId,
        targetKind: schema.paidReplyAnalysisAttempts.targetKind,
        status: schema.paidReplyAnalysisAttempts.status,
      })
      .from(schema.paidReplyAnalysisAttempts)
      .where(
        and(
          eq(schema.paidReplyAnalysisAttempts.orgId, job.orgId),
          eq(schema.paidReplyAnalysisAttempts.id, job.attemptId),
        ),
      );
    if (!attempt?.admissionId || attempt.status !== "dispatching")
      throw new Error("paid_reply_fence_lost");
    await db.insert(schema.usageLedger).values({
      orgId: job.orgId,
      brandId: attempt.brandId,
      analysisAdmissionId: attempt.admissionId,
      step:
        attempt.targetKind === "source_comment"
          ? "comment_analysis"
          : "publication_comment_analysis",
      provider: record.provider,
      modelId: record.modelId,
      attempt: 1,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cachedInputTokens: record.cachedInputTokens,
      reasoningTokens: record.reasoningTokens,
      costUsd: record.costUsd === null ? null : record.costUsd.toFixed(6),
      costSource: record.costSource,
      status: record.status,
      outcome: record.outcome,
      responseMs: record.responseMs,
      keyOwnership: "byok",
    });
  }

  async finish(job: PaidReplyAnalysisJob, generation: PaidReplyGeneration | null): Promise<void> {
    const [hint] = await db
      .select()
      .from(schema.paidReplyAnalysisAttempts)
      .where(
        and(
          eq(schema.paidReplyAnalysisAttempts.orgId, job.orgId),
          eq(schema.paidReplyAnalysisAttempts.id, job.attemptId),
        ),
      );
    if (hint?.status !== "dispatching") return;
    const target: Target = {
      orgId: hint.orgId,
      brandId: hint.brandId,
      kind: hint.targetKind,
      id: hint.targetId,
      version: hint.sampleVersion,
      automatic: hint.origin === "automatic",
    };
    await db.transaction(async (tx) => {
      const [org] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, job.orgId))
        .for("no key update");
      if (!org) return;
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, job.orgId), eq(schema.brands.id, hint.brandId)))
        .for("key share");
      const live = brand ? await lockTarget(tx, target) : null;
      const [attempt] = await tx
        .select()
        .from(schema.paidReplyAnalysisAttempts)
        .where(eq(schema.paidReplyAnalysisAttempts.id, job.attemptId))
        .for("update");
      if (attempt?.status !== "dispatching") return;
      const [metering] = await tx
        .select({ outcome: schema.usageLedger.outcome, cost: schema.usageLedger.costUsd })
        .from(schema.usageLedger)
        .where(eq(schema.usageLedger.analysisAdmissionId, attempt.admissionId as string));
      const goodMeter = !!metering && metering.outcome === "completed" && metering.cost !== null;
      const status =
        !metering || metering.outcome === "unknown"
          ? "unknown"
          : generation?.ok && goodMeter && live
            ? "ready"
            : generation?.ok && goodMeter
              ? "stale"
              : "failed";
      if (status === "ready" && generation?.ok && live) {
        const values = {
          orgId: target.orgId,
          brandId: target.brandId,
          sampleCheckedAt: live.checkedAt,
          sampleVersion: target.version,
          sampleSize: attempt.sampleSize as number,
          result: generation.result,
        };
        if (target.kind === "source_comment") {
          await tx
            .insert(schema.newsCommentAnalyses)
            .values({ itemId: target.id, ...values })
            .onConflictDoUpdate({ target: schema.newsCommentAnalyses.itemId, set: values });
        } else {
          await tx
            .insert(schema.publicationCommentAnalyses)
            .values({ publicationId: target.id, ...values })
            .onConflictDoUpdate({
              target: schema.publicationCommentAnalyses.publicationId,
              set: values,
            });
        }
      }
      await tx
        .update(schema.paidReplyAnalysisAttempts)
        .set({
          status,
          failureCode: status === "ready" ? null : status,
          completedAt: sql`now()`,
          ...(live ? {} : { promptEncrypted: null }),
        })
        .where(eq(schema.paidReplyAnalysisAttempts.id, attempt.id));
      if (attempt.admissionId)
        await tx
          .update(schema.analysisAdmissions)
          .set({ completedAt: sql`now()` })
          .where(eq(schema.analysisAdmissions.id, attempt.admissionId));
    });
  }

  async markUnrecorded(job: PaidReplyAnalysisJob): Promise<void> {
    const [attempt] = await db
      .select({ admissionId: schema.paidReplyAnalysisAttempts.admissionId })
      .from(schema.paidReplyAnalysisAttempts)
      .where(eq(schema.paidReplyAnalysisAttempts.id, job.attemptId));
    if (attempt?.admissionId)
      await db
        .update(schema.analysisAdmissions)
        .set({ unrecordedCalls: sql`${schema.analysisAdmissions.unrecordedCalls} + 1` })
        .where(eq(schema.analysisAdmissions.id, attempt.admissionId));
  }

  /** Unknown dispatched work never re-enters the paid queue. */
  async sweep(boss: PgBoss): Promise<void> {
    const stale = await db
      .select({
        id: schema.paidReplyAnalysisAttempts.id,
        orgId: schema.paidReplyAnalysisAttempts.orgId,
      })
      .from(schema.paidReplyAnalysisAttempts)
      .where(
        and(
          eq(schema.paidReplyAnalysisAttempts.status, "dispatching"),
          sql`${schema.paidReplyAnalysisAttempts.dispatchStartedAt} < now() - interval '5 minutes'`,
        ),
      )
      .orderBy(asc(schema.paidReplyAnalysisAttempts.dispatchStartedAt))
      .limit(BATCH_SIZE);
    for (const row of stale) await this.finish({ orgId: row.orgId, attemptId: row.id }, null);
    const queued = await db
      .select({
        id: schema.paidReplyAnalysisAttempts.id,
        orgId: schema.paidReplyAnalysisAttempts.orgId,
      })
      .from(schema.paidReplyAnalysisAttempts)
      .where(
        and(
          eq(schema.paidReplyAnalysisAttempts.status, "queued"),
          sql`${schema.paidReplyAnalysisAttempts.createdAt} < now() - interval '2 minutes'`,
        ),
      )
      .orderBy(asc(schema.paidReplyAnalysisAttempts.createdAt))
      .limit(BATCH_SIZE);
    for (const row of queued)
      await boss.send(
        PAID_REPLY_ANALYSIS_QUEUE,
        { orgId: row.orgId, attemptId: row.id },
        paidReplyAnalysisJobOptions(row.id, row.orgId),
      );
    await db
      .update(schema.paidReplyAnalysisAttempts)
      .set({ promptEncrypted: null })
      .where(sql`${schema.paidReplyAnalysisAttempts.id} IN (
        SELECT id FROM paid_reply_analysis_attempts
        WHERE completed_at < now() - interval '30 days' AND prompt_encrypted IS NOT NULL
        ORDER BY completed_at, id LIMIT ${BATCH_SIZE}
      )`);
  }
}
