import { Injectable } from "@nestjs/common";
import type { UsageRecord } from "@pubrick/ai";
import { schema } from "@pubrick/db";
import { toLedgerCostUsd } from "@pubrick/shared";
import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "../db";

@Injectable()
export class RelevanceRepository {
  /** Privileged scheduler scan; only unscored rows are picked, twenty per hour. */
  async unscored(afterId?: string) {
    return db
      .select({
        orgId: schema.newsItems.orgId,
        brandId: schema.newsItems.brandId,
        itemId: schema.newsItems.id,
      })
      .from(schema.newsItems)
      .where(
        and(
          eq(schema.newsItems.relevanceStatus, "unscored"),
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

  async scored(
    orgId: string,
    brandId: string,
    itemId: string,
    result: { score: number; reason: string; urgency: "breaking" | "timely" | "evergreen" },
  ) {
    await db
      .update(schema.newsItems)
      .set({
        relevanceStatus: "scored",
        relevanceScore: result.score,
        relevanceReason: result.reason,
        relevanceUrgency: result.urgency,
        relevanceErrorCode: null,
        relevanceScoredAt: new Date(),
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
}
