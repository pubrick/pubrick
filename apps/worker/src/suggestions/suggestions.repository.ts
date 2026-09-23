import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import type { UsageRecord } from "@pubrick/ai";
import { schema } from "@pubrick/db";
import { toLedgerCostUsd } from "@pubrick/shared";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import { db } from "../db";

export function topicKey(title: string): string {
  return createHash("sha256")
    .update(title.normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/g, " ").trim())
    .digest("hex");
}

export type Suggestion = { title: string; description: string; newsItemId: string | null };

@Injectable()
export class SuggestionsRepository {
  async claim(orgId: string, brandId: string, requestId: string) {
    const claimed = await db
      .update(schema.topicSuggestionRequests)
      .set({
        status: "running",
        errorCode: null,
        attempts: sql`${schema.topicSuggestionRequests.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.topicSuggestionRequests.orgId, orgId),
          eq(schema.topicSuggestionRequests.brandId, brandId),
          eq(schema.topicSuggestionRequests.id, requestId),
          lt(schema.topicSuggestionRequests.attempts, 3),
          sql`${schema.topicSuggestionRequests.status} <> 'succeeded'`,
        ),
      )
      .returning({ id: schema.topicSuggestionRequests.id });
    if (!claimed[0]) return null;
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
    if (!brands[0]) return null;
    const topics = await db
      .select({
        title: schema.topics.title,
        description: schema.topics.description,
        status: schema.topics.status,
      })
      .from(schema.topics)
      .where(
        and(
          eq(schema.topics.orgId, orgId),
          eq(schema.topics.brandId, brandId),
          eq(schema.topics.status, "approved"),
        ),
      )
      .orderBy(desc(schema.topics.createdAt))
      .limit(30);
    const news = await db
      .select({
        id: schema.newsItems.id,
        title: schema.newsItems.title,
        summary: schema.newsItems.summary,
        url: schema.newsItems.url,
        score: schema.newsItems.relevanceScore,
        reason: schema.newsItems.relevanceReason,
        editorSignal: schema.newsItems.editorSignal,
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
          eq(schema.newsItems.orgId, orgId),
          eq(schema.newsItems.brandId, brandId),
          eq(schema.newsItems.relevanceStatus, "scored"),
          sql`${schema.newsSources.kind} <> 'telegram_private'`,
        ),
      )
      .orderBy(desc(schema.newsItems.relevanceScore), desc(schema.newsItems.createdAt))
      .limit(40);
    return {
      brand: brands[0],
      topics,
      news: news
        .filter(
          (item) =>
            item.editorSignal !== "irrelevant" &&
            (item.editorSignal === "relevant" || (item.score ?? 0) >= 0.6),
        )
        .slice(0, 10),
    };
  }

  async complete(
    orgId: string,
    brandId: string,
    requestId: string,
    suggestions: Suggestion[],
    news: Array<{ id: string; url: string }>,
  ) {
    return db.transaction(async (tx) => {
      const requests = await tx
        .select({ status: schema.topicSuggestionRequests.status })
        .from(schema.topicSuggestionRequests)
        .where(
          and(
            eq(schema.topicSuggestionRequests.orgId, orgId),
            eq(schema.topicSuggestionRequests.brandId, brandId),
            eq(schema.topicSuggestionRequests.id, requestId),
          ),
        )
        .for("update");
      if (!requests[0] || requests[0].status === "succeeded") return 0;
      const existing = await tx
        .select({ title: schema.topics.title })
        .from(schema.topics)
        .where(and(eq(schema.topics.orgId, orgId), eq(schema.topics.brandId, brandId)));
      const seen = new Set(existing.map((topic) => topicKey(topic.title)));
      const allowedNews = new Map(news.map((item) => [item.id, item.url]));
      let count = 0;
      for (const suggestion of suggestions.slice(0, 3)) {
        const key = topicKey(suggestion.title);
        if (seen.has(key)) continue;
        seen.add(key);
        const sourceUrl = suggestion.newsItemId
          ? (allowedNews.get(suggestion.newsItemId) ?? null)
          : null;
        const rows = await tx
          .insert(schema.topics)
          .values({
            orgId,
            brandId,
            title: suggestion.title,
            description: suggestion.description,
            sourceUrl,
            origin: "ai",
            suggestionKey: key,
          })
          .onConflictDoNothing()
          .returning({ id: schema.topics.id });
        count += rows.length;
      }
      await tx
        .update(schema.topicSuggestionRequests)
        .set({
          status: "succeeded",
          errorCode: null,
          suggestionCount: count,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.topicSuggestionRequests.orgId, orgId),
            eq(schema.topicSuggestionRequests.brandId, brandId),
            eq(schema.topicSuggestionRequests.id, requestId),
          ),
        );
      return count;
    });
  }

  async failed(
    orgId: string,
    brandId: string,
    requestId: string,
    code: "no_api_key" | "unreadable_key" | "model_failed",
  ) {
    await db
      .update(schema.topicSuggestionRequests)
      .set({
        status: "failed",
        errorCode: code,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.topicSuggestionRequests.orgId, orgId),
          eq(schema.topicSuggestionRequests.brandId, brandId),
          eq(schema.topicSuggestionRequests.id, requestId),
          sql`${schema.topicSuggestionRequests.status} <> 'succeeded'`,
        ),
      );
  }

  async recordUsage(orgId: string, record: UsageRecord) {
    await db.insert(schema.usageLedger).values({
      orgId,
      step: "topic_suggestions",
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
