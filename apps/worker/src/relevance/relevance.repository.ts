import { Injectable } from "@nestjs/common";
import { KNOWLEDGE_EMBEDDING_MODEL, type UsageRecord } from "@pubrick/ai";
import { schema } from "@pubrick/db";
import { decryptJson, parseStoredAiCredential, toLedgerCostUsd } from "@pubrick/shared";
import { and, asc, desc, eq, gt, lt, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";
import type { FeedbackSignals } from "./feedback-adjustment";

@Injectable()
export class RelevanceRepository {
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
