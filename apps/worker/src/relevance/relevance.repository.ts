import { Injectable } from "@nestjs/common";
import { type FeedbackSignals, KNOWLEDGE_EMBEDDING_MODEL, type UsageRecord } from "@pubrick/ai";
import { schema } from "@pubrick/db";
import {
  decryptJson,
  parseStoredAiCredential,
  RELEVANCE_BATCH_QUEUE,
  toLedgerCostUsd,
} from "@pubrick/shared";
import { and, asc, desc, eq, gt, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";

@Injectable()
export class RelevanceRepository {
  async isVisible(orgId: string, brandId: string, itemId: string): Promise<boolean> {
    const [item] = await db
      .select({ id: schema.newsItems.id })
      .from(schema.newsItems)
      .where(
        and(
          eq(schema.newsItems.orgId, orgId),
          eq(schema.newsItems.brandId, brandId),
          eq(schema.newsItems.id, itemId),
          isNull(schema.newsItems.dismissedAt),
        ),
      )
      .limit(1);
    return Boolean(item);
  }

  /** Privileged repair scan: terminal or missing queue jobs must not hold a brand's paid-action lock forever. */
  async orphanedBatchJobs() {
    const result = await db.execute(sql`SELECT i.org_id AS "orgId", i.brand_id AS "brandId",
      i.batch_id AS "batchId", i.item_id AS "itemId"
      FROM news_relevance_batch_items i
      JOIN news_relevance_batches b ON b.id = i.batch_id AND b.org_id = i.org_id AND b.brand_id = i.brand_id
      LEFT JOIN pgboss.job j ON j.id = i.id AND j.name = ${RELEVANCE_BATCH_QUEUE}
      WHERE b.status IN ('queued', 'running', 'halting') AND i.status IN ('queued', 'running')
      AND (j.id IS NULL OR j.state::text IN ('failed', 'completed', 'cancelled'))
      ORDER BY b.created_at, i.id LIMIT 100`);
    return result.rows as Array<{
      orgId: string;
      brandId: string;
      batchId: string;
      itemId: string;
    }>;
  }
  async recordBatchUsageLoss(orgId: string, brandId: string, batchId: string) {
    const [recorded] = await db
      .update(schema.relevanceBatches)
      .set({ unrecordedCalls: sql`${schema.relevanceBatches.unrecordedCalls} + 1` })
      .where(
        and(
          eq(schema.relevanceBatches.orgId, orgId),
          eq(schema.relevanceBatches.brandId, brandId),
          eq(schema.relevanceBatches.id, batchId),
        ),
      )
      .returning({ id: schema.relevanceBatches.id });
    if (!recorded) throw new Error("Batch usage loss could not be recorded");
  }
  async claimBatch(orgId: string, brandId: string, batchId: string, itemId: string) {
    return db.transaction(async (tx) => {
      // Claim and terminal stop serialize on this row. A queued item cannot
      // become payable after the batch has entered halting or halted state.
      const [batch] = await tx
        .select({ status: schema.relevanceBatches.status })
        .from(schema.relevanceBatches)
        .where(
          and(
            eq(schema.relevanceBatches.orgId, orgId),
            eq(schema.relevanceBatches.brandId, brandId),
            eq(schema.relevanceBatches.id, batchId),
          ),
        )
        .for("update")
        .limit(1);
      if (!batch || (batch.status !== "queued" && batch.status !== "running")) return null;
      const [claimed] = await tx
        .update(schema.relevanceBatchItems)
        .set({ status: "running" })
        .where(
          and(
            eq(schema.relevanceBatchItems.orgId, orgId),
            eq(schema.relevanceBatchItems.brandId, brandId),
            eq(schema.relevanceBatchItems.batchId, batchId),
            eq(schema.relevanceBatchItems.itemId, itemId),
            eq(schema.relevanceBatchItems.status, "queued"),
          ),
        )
        .returning({ itemId: schema.relevanceBatchItems.itemId });
      if (!claimed) return null;
      if (batch.status === "queued")
        await tx
          .update(schema.relevanceBatches)
          .set({ status: "running", startedAt: new Date() })
          .where(eq(schema.relevanceBatches.id, batchId));
      const [item] = await tx
        .select({
          title: schema.newsItems.title,
          summary: schema.newsItems.summary,
          publishedAt: schema.newsItems.publishedAt,
        })
        .from(schema.newsItems)
        .where(
          and(
            eq(schema.newsItems.orgId, orgId),
            eq(schema.newsItems.brandId, brandId),
            eq(schema.newsItems.id, itemId),
            isNull(schema.newsItems.dismissedAt),
          ),
        )
        .limit(1);
      const [brand] = await tx
        .select({
          name: schema.brands.name,
          description: schema.brands.description,
          voice: schema.brands.voice,
          audience: schema.brands.audience,
          contentLanguage: schema.brands.contentLanguage,
        })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
        .limit(1);
      return item && brand ? { ...item, brand } : { missing: true as const };
    });
  }

  /** Each result and its progress counters commit together. A failed recheck never erases an older score. */
  async finishBatch(
    orgId: string,
    brandId: string,
    batchId: string,
    itemId: string,
    result:
      | {
          kind: "scored";
          score: number;
          feedbackDelta: number;
          reason: string;
          urgency: "breaking" | "timely" | "evergreen";
          embedding?: number[] | null;
        }
      | {
          kind: "failed";
          code:
            | "no_api_key"
            | "unreadable_key"
            | "invalid_key"
            | "model_not_found"
            | "provider_refused"
            | "model_failed";
          halt?: boolean;
        }
      | { kind: "skipped" },
  ) {
    await db.transaction(async (tx) => {
      const [batch] = await tx
        .select({
          selectedCount: schema.relevanceBatches.selectedCount,
          processedCount: schema.relevanceBatches.processedCount,
          updatedCount: schema.relevanceBatches.updatedCount,
          failedCount: schema.relevanceBatches.failedCount,
          skippedCount: schema.relevanceBatches.skippedCount,
          status: schema.relevanceBatches.status,
          errorCode: schema.relevanceBatches.errorCode,
        })
        .from(schema.relevanceBatches)
        .where(
          and(
            eq(schema.relevanceBatches.orgId, orgId),
            eq(schema.relevanceBatches.brandId, brandId),
            eq(schema.relevanceBatches.id, batchId),
          ),
        )
        .for("update")
        .limit(1);
      if (!batch || !["queued", "running", "halting"].includes(batch.status)) return;
      const [pending] = await tx
        .select({ id: schema.relevanceBatchItems.id })
        .from(schema.relevanceBatchItems)
        .where(
          and(
            eq(schema.relevanceBatchItems.orgId, orgId),
            eq(schema.relevanceBatchItems.brandId, brandId),
            eq(schema.relevanceBatchItems.batchId, batchId),
            eq(schema.relevanceBatchItems.itemId, itemId),
            inArray(
              schema.relevanceBatchItems.status,
              batch.status === "halting" ? ["running"] : ["queued", "running"],
            ),
          ),
        )
        .limit(1);
      if (!pending) return;
      let outcome: "scored" | "failed" | "skipped" = result.kind;
      if (result.kind === "scored") {
        const [saved] = await tx
          .update(schema.newsItems)
          .set({
            relevanceStatus: "scored",
            relevanceScore: result.score,
            relevanceFeedbackDelta: result.feedbackDelta,
            relevanceReason: result.reason,
            relevanceUrgency: result.urgency,
            relevanceErrorCode: null,
            relevanceScoredAt: new Date(),
            relevanceAttempts: 0,
            // A successful new verdict must not erase a usable vector merely
            // because the optional embedding call was unavailable this time.
            ...(result.embedding
              ? {
                  embedding: result.embedding,
                  embeddingModel: KNOWLEDGE_EMBEDDING_MODEL,
                  embeddingDimensions: result.embedding.length,
                }
              : {}),
          })
          .where(
            and(
              eq(schema.newsItems.orgId, orgId),
              eq(schema.newsItems.brandId, brandId),
              eq(schema.newsItems.id, itemId),
            ),
          )
          .returning({ id: schema.newsItems.id });
        if (!saved) outcome = "skipped";
      }
      await tx
        .update(schema.relevanceBatchItems)
        .set({
          status: outcome,
          errorCode: result.kind === "failed" ? result.code : null,
          completedAt: new Date(),
        })
        .where(eq(schema.relevanceBatchItems.id, pending.id));
      const halting = batch.status === "halting" || (result.kind === "failed" && result.halt);
      const remaining = halting
        ? await tx
            .update(schema.relevanceBatchItems)
            .set({ status: "skipped", completedAt: new Date() })
            .where(
              and(
                eq(schema.relevanceBatchItems.orgId, orgId),
                eq(schema.relevanceBatchItems.brandId, brandId),
                eq(schema.relevanceBatchItems.batchId, batchId),
                eq(schema.relevanceBatchItems.status, "queued"),
              ),
            )
            .returning({ id: schema.relevanceBatchItems.id })
        : [];
      const processed = batch.processedCount + 1 + remaining.length;
      const updated = batch.updatedCount + Number(outcome === "scored");
      const failed = batch.failedCount + Number(outcome === "failed");
      const skipped = batch.skippedCount + Number(outcome === "skipped") + remaining.length;
      await tx
        .update(schema.relevanceBatches)
        .set({
          processedCount: processed,
          updatedCount: updated,
          failedCount: failed,
          skippedCount: skipped,
          status: halting
            ? processed === batch.selectedCount
              ? "halted"
              : "halting"
            : processed === batch.selectedCount
              ? failed + skipped
                ? "partial"
                : "completed"
              : "running",
          errorCode: halting
            ? (batch.errorCode ?? (result.kind === "failed" ? result.code : null))
            : null,
          completedAt: processed === batch.selectedCount ? new Date() : null,
        })
        .where(
          and(
            eq(schema.relevanceBatches.orgId, orgId),
            eq(schema.relevanceBatches.brandId, brandId),
            eq(schema.relevanceBatches.id, batchId),
          ),
        );
    });
  }
  /** The relevance verdict provider can differ from the organization's Google BYOK key. */
  async googleKey(orgId: string): Promise<string | undefined> {
    const [row] = await db
      .select({ encrypted: schema.aiCredentials.credentialsEncrypted })
      .from(schema.aiCredentials)
      .where(
        and(eq(schema.aiCredentials.orgId, orgId), eq(schema.aiCredentials.provider, "google")),
      )
      .limit(1);
    return row
      ? parseStoredAiCredential(decryptJson(row.encrypted, env.APP_ENCRYPTION_KEY)).apiKey
      : undefined;
  }

  /** Privileged scheduler scan; only unscored rows are picked, twenty per hour. */
  async unscored(afterId?: string) {
    return db
      .select({
        orgId: schema.newsItems.orgId,
        brandId: schema.newsItems.brandId,
        itemId: schema.newsItems.id,
      })
      .from(schema.newsItems)
      .innerJoin(
        schema.newsSources,
        and(
          eq(schema.newsItems.sourceId, schema.newsSources.id),
          eq(schema.newsItems.orgId, schema.newsSources.orgId),
          eq(schema.newsItems.brandId, schema.newsSources.brandId),
        ),
      )
      .where(
        and(
          eq(schema.newsItems.relevanceStatus, "unscored"),
          isNull(schema.newsItems.dismissedAt),
          sql`${schema.newsSources.kind} <> 'telegram_private'`,
          ...(afterId ? [gt(schema.newsItems.id, afterId)] : []),
        ),
      )
      .orderBy(asc(schema.newsItems.id))
      .limit(20);
  }

  async claim(orgId: string, brandId: string, itemId: string) {
    const rows = await db
      .update(schema.newsItems)
      .set({
        relevanceAttempts: sql`${schema.newsItems.relevanceAttempts} + 1`,
      })
      .where(
        and(
          eq(schema.newsItems.orgId, orgId),
          eq(schema.newsItems.brandId, brandId),
          eq(schema.newsItems.id, itemId),
          lt(schema.newsItems.relevanceAttempts, 3),
          sql`${schema.newsItems.relevanceStatus} <> 'scored'`,
          isNull(schema.newsItems.dismissedAt),
        ),
      )
      .returning({
        title: schema.newsItems.title,
        summary: schema.newsItems.summary,
        publishedAt: schema.newsItems.publishedAt,
      });
    if (!rows[0]) return null;
    const brands = await db
      .select({
        name: schema.brands.name,
        description: schema.brands.description,
        voice: schema.brands.voice,
        audience: schema.brands.audience,
        contentLanguage: schema.brands.contentLanguage,
      })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    return brands[0] ? { ...rows[0], brand: brands[0] } : null;
  }

  /** Latest marked articles of each kind, restricted to this workspace and brand. */
  async recentFeedback(orgId: string, brandId: string, itemId: string): Promise<FeedbackSignals> {
    const fetch = (signal: "relevant" | "irrelevant") =>
      db
        .select({
          title: schema.newsItems.title,
          summary: schema.newsItems.summary,
          embedding: schema.newsItems.embedding,
          embeddingModel: schema.newsItems.embeddingModel,
          embeddingDimensions: schema.newsItems.embeddingDimensions,
        })
        .from(schema.newsItems)
        .where(
          and(
            eq(schema.newsItems.orgId, orgId),
            eq(schema.newsItems.brandId, brandId),
            ne(schema.newsItems.id, itemId),
            eq(schema.newsItems.editorSignal, signal),
          ),
        )
        .orderBy(desc(schema.newsItems.createdAt), desc(schema.newsItems.id))
        .limit(50);
    const [relevant, irrelevant] = await Promise.all([fetch("relevant"), fetch("irrelevant")]);
    return { relevant, irrelevant };
  }

  async scored(
    orgId: string,
    brandId: string,
    itemId: string,
    result: {
      score: number;
      feedbackDelta: number;
      reason: string;
      urgency: "breaking" | "timely" | "evergreen";
      embedding?: number[] | null;
    },
  ) {
    await db
      .update(schema.newsItems)
      .set({
        relevanceStatus: "scored",
        relevanceScore: result.score,
        relevanceFeedbackDelta: result.feedbackDelta,
        relevanceReason: result.reason,
        relevanceUrgency: result.urgency,
        relevanceErrorCode: null,
        relevanceScoredAt: new Date(),
        embedding: result.embedding ?? null,
        embeddingModel: result.embedding ? KNOWLEDGE_EMBEDDING_MODEL : null,
        embeddingDimensions: result.embedding ? result.embedding.length : null,
      })
      .where(
        and(
          eq(schema.newsItems.orgId, orgId),
          eq(schema.newsItems.brandId, brandId),
          eq(schema.newsItems.id, itemId),
          isNull(schema.newsItems.dismissedAt),
        ),
      );
  }

  async failed(
    orgId: string,
    brandId: string,
    itemId: string,
    code: "no_api_key" | "unreadable_key" | "model_failed",
  ) {
    await db
      .update(schema.newsItems)
      .set({
        relevanceStatus: "failed",
        relevanceScore: null,
        relevanceReason: null,
        relevanceUrgency: null,
        relevanceScoredAt: null,
        relevanceErrorCode: code,
      })
      .where(
        and(
          eq(schema.newsItems.orgId, orgId),
          eq(schema.newsItems.brandId, brandId),
          eq(schema.newsItems.id, itemId),
          sql`${schema.newsItems.relevanceStatus} <> 'scored'`,
          isNull(schema.newsItems.dismissedAt),
        ),
      );
  }

  /** A lost result write must not leave an unscored row stuck at its call cap. */
  async markAttemptLimit(orgId: string, brandId: string, itemId: string) {
    await db
      .update(schema.newsItems)
      .set({
        relevanceStatus: "failed",
        relevanceErrorCode: "model_failed",
      })
      .where(
        and(
          eq(schema.newsItems.orgId, orgId),
          eq(schema.newsItems.brandId, brandId),
          eq(schema.newsItems.id, itemId),
          eq(schema.newsItems.relevanceStatus, "unscored"),
          sql`${schema.newsItems.relevanceAttempts} >= 3`,
          isNull(schema.newsItems.dismissedAt),
        ),
      );
  }

  /** One independent ledger transaction per physical model call. */
  async recordUsage(orgId: string, record: UsageRecord) {
    await db.insert(schema.usageLedger).values({
      orgId,
      step: "news_relevance",
      provider: record.provider,
      modelId: record.modelId,
      attempt: record.attempt,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cachedInputTokens: record.cachedInputTokens,
      reasoningTokens: record.reasoningTokens,
      costUsd: toLedgerCostUsd(record.costUsd),
      costSource: record.costSource,
      status: record.status,
      outcome: record.outcome,
      responseMs: record.responseMs,
      keyOwnership: "byok",
    });
  }

  /** A separate ledger entry is written for each physical Google embedding call. */
  async recordEmbeddingUsage(
    orgId: string,
    tokens: number,
    responseMs: number,
    status: "ok" | "errored",
    outcome: "completed" | "refused" | "unknown",
  ) {
    await db.insert(schema.usageLedger).values({
      orgId,
      step: "news_feedback_embedding",
      provider: "google",
      modelId: KNOWLEDGE_EMBEDDING_MODEL,
      attempt: 1,
      inputTokens: Number.isFinite(tokens) ? tokens : 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      costUsd: null,
      costSource: "unknown",
      status,
      outcome,
      responseMs,
      keyOwnership: "byok",
    });
  }
}
