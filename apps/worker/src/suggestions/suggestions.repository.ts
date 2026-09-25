import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { KNOWLEDGE_EMBEDDING_MODEL, type UsageRecord } from "@pubrick/ai";
import { newsRankScore, schema } from "@pubrick/db";
import { decryptJson, parseStoredAiCredential, toLedgerCostUsd } from "@pubrick/shared";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";

export function topicKey(title: string): string {
  return createHash("sha256")
    .update(title.normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/g, " ").trim())
    .digest("hex");
}

export type Suggestion = { title: string; description: string; newsItemId: string | null };

// Three proposal titles and all twenty recent reviewer blocks fit in three
// ten-text embedding calls. Overflow refuses the manual request before AI spend.
export const MANUAL_BLOCKED_TOPIC_LIMIT = 20;
export const MANUAL_EMBEDDING_CALL_LIMIT = 3;
export type BlockedTopicSnapshot = { titles: string[]; state: string };

function blockedState(
  rows: Array<{ id: string; title: string; revision: number; blockedAt: Date | null }>,
) {
  return JSON.stringify(
    rows.map((row) => [row.id, row.title, row.revision, row.blockedAt?.toISOString()]),
  );
}

// Provider calls are bounded to 60 seconds; this permits several queue expiry
// windows before declaring a worker that stopped heartbeating abandoned.
const STALE_AUTOMATIC_MINUTES = 10;
export const STALE_AUTOMATIC_SWEEP_LIMIT = 100;

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
          sql`(${schema.topicSuggestionRequests.origin} = 'manual' and ${schema.topicSuggestionRequests.attempts} < 3 or ${schema.topicSuggestionRequests.origin} = 'automatic' and ${schema.topicSuggestionRequests.attempts} = 0 and ${schema.topicSuggestionRequests.status} = 'queued')`,
          sql`${schema.topicSuggestionRequests.status} <> 'succeeded'`,
        ),
      )
      .returning({
        id: schema.topicSuggestionRequests.id,
        origin: schema.topicSuggestionRequests.origin,
        localDate: schema.topicSuggestionRequests.localDate,
        attempts: schema.topicSuggestionRequests.attempts,
      });
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
        score: newsRankScore,
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
      .orderBy(desc(newsRankScore), desc(schema.newsItems.createdAt))
      .limit(40);
    return {
      origin: claimed[0].origin,
      localDate: claimed[0].localDate,
      attempt: claimed[0].attempts,
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

  /** A delivery whose attempt was superseded cannot buy another provider call. */
  async isActive(orgId: string, brandId: string, requestId: string, attempt: number) {
    const [row] = await db
      .select({ id: schema.topicSuggestionRequests.id })
      .from(schema.topicSuggestionRequests)
      .where(
        and(
          eq(schema.topicSuggestionRequests.orgId, orgId),
          eq(schema.topicSuggestionRequests.brandId, brandId),
          eq(schema.topicSuggestionRequests.id, requestId),
          eq(schema.topicSuggestionRequests.status, "running"),
          eq(schema.topicSuggestionRequests.attempts, attempt),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  /** Includes blocked human-created topics; no origin or suggestion-key filter. */
  async recentBlocked(orgId: string, brandId: string): Promise<BlockedTopicSnapshot | null> {
    const rows = await db
      .select({
        id: schema.topics.id,
        title: schema.topics.title,
        revision: schema.topics.revision,
        blockedAt: schema.topics.blockedAt,
      })
      .from(schema.topics)
      .where(
        and(
          eq(schema.topics.orgId, orgId),
          eq(schema.topics.brandId, brandId),
          sql`${schema.topics.blockedAt} >= now() - interval '90 days'`,
        ),
      )
      .orderBy(desc(schema.topics.blockedAt), desc(schema.topics.id))
      .limit(MANUAL_BLOCKED_TOPIC_LIMIT + 1);
    if (rows.length > MANUAL_BLOCKED_TOPIC_LIMIT) return null;
    return { titles: rows.map((row) => row.title), state: blockedState(rows) };
  }

  /** Embeddings need a Google BYOK key even when the text model uses OpenRouter. */
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

  async heartbeatAutomatic(orgId: string, brandId: string, requestId: string): Promise<void> {
    await db
      .update(schema.topicSuggestionRequests)
      .set({ updatedAt: new Date() })
      .where(
        and(
          eq(schema.topicSuggestionRequests.orgId, orgId),
          eq(schema.topicSuggestionRequests.brandId, brandId),
          eq(schema.topicSuggestionRequests.id, requestId),
          eq(schema.topicSuggestionRequests.origin, "automatic"),
          eq(schema.topicSuggestionRequests.status, "running"),
        ),
      );
  }

  async recoverStaleAutomatic(orgId: string, brandId: string, requestId: string): Promise<boolean> {
    const recovered = await db
      .update(schema.topicSuggestionRequests)
      .set({ status: "failed", errorCode: "model_failed", updatedAt: new Date() })
      .where(
        and(
          eq(schema.topicSuggestionRequests.orgId, orgId),
          eq(schema.topicSuggestionRequests.brandId, brandId),
          eq(schema.topicSuggestionRequests.id, requestId),
          eq(schema.topicSuggestionRequests.origin, "automatic"),
          eq(schema.topicSuggestionRequests.status, "running"),
          sql`${schema.topicSuggestionRequests.updatedAt} < now() - ${STALE_AUTOMATIC_MINUTES} * interval '1 minute'`,
        ),
      )
      .returning({ id: schema.topicSuggestionRequests.id });
    return recovered.length > 0;
  }

  async sweepStaleAutomatic(): Promise<number> {
    const candidates = db
      .select({ id: schema.topicSuggestionRequests.id })
      .from(schema.topicSuggestionRequests)
      .where(
        and(
          eq(schema.topicSuggestionRequests.origin, "automatic"),
          eq(schema.topicSuggestionRequests.status, "running"),
          sql`${schema.topicSuggestionRequests.updatedAt} < now() - ${STALE_AUTOMATIC_MINUTES} * interval '1 minute'`,
        ),
      )
      .orderBy(asc(schema.topicSuggestionRequests.id))
      .limit(STALE_AUTOMATIC_SWEEP_LIMIT)
      .for("update", { skipLocked: true });
    const recovered = await db
      .update(schema.topicSuggestionRequests)
      .set({ status: "failed", errorCode: "model_failed", updatedAt: new Date() })
      .where(
        and(
          eq(schema.topicSuggestionRequests.origin, "automatic"),
          eq(schema.topicSuggestionRequests.status, "running"),
          sql`${schema.topicSuggestionRequests.updatedAt} < now() - ${STALE_AUTOMATIC_MINUTES} * interval '1 minute'`,
          inArray(schema.topicSuggestionRequests.id, candidates),
        ),
      )
      .returning({ id: schema.topicSuggestionRequests.id });
    return recovered.length;
  }

  async complete(
    orgId: string,
    brandId: string,
    requestId: string,
    suggestions: Suggestion[],
    news: Array<{ id: string; url: string }>,
    expectedAttempt?: number,
    blockedSnapshot?: BlockedTopicSnapshot,
  ) {
    return db.transaction(async (tx) => {
      // Block/unblock and topic edits take this same lock before touching
      // topics, giving exact-title suppression a stable snapshot.
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
        .for("no key update");
      if (!brand) return 0;
      const requests = await tx
        .select({
          status: schema.topicSuggestionRequests.status,
          attempts: schema.topicSuggestionRequests.attempts,
        })
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
      if (
        expectedAttempt !== undefined &&
        (requests[0].status !== "running" || requests[0].attempts !== expectedAttempt)
      )
        return 0;
      if (blockedSnapshot) {
        const current = await tx
          .select({
            id: schema.topics.id,
            title: schema.topics.title,
            revision: schema.topics.revision,
            blockedAt: schema.topics.blockedAt,
          })
          .from(schema.topics)
          .where(
            and(
              eq(schema.topics.orgId, orgId),
              eq(schema.topics.brandId, brandId),
              sql`${schema.topics.blockedAt} >= now() - interval '90 days'`,
            ),
          )
          .orderBy(desc(schema.topics.blockedAt), desc(schema.topics.id))
          .limit(MANUAL_BLOCKED_TOPIC_LIMIT + 1);
        if (
          current.length > MANUAL_BLOCKED_TOPIC_LIMIT ||
          blockedState(current) !== blockedSnapshot.state
        ) {
          await tx
            .update(schema.topicSuggestionRequests)
            .set({ status: "failed", errorCode: "model_failed", updatedAt: new Date() })
            .where(eq(schema.topicSuggestionRequests.id, requestId));
          return 0;
        }
      }
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
    expectedAttempt?: number,
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
          ...(expectedAttempt === undefined
            ? []
            : [eq(schema.topicSuggestionRequests.attempts, expectedAttempt)]),
        ),
      );
  }

  /** Each batch is one physical call, recorded before any suggestion is saved. */
  async recordEmbeddingUsage(
    orgId: string,
    tokens: number,
    responseMs: number,
    status: "ok" | "errored",
    outcome: "completed" | "refused" | "unknown",
  ) {
    await db.insert(schema.usageLedger).values({
      orgId,
      step: "topic_block_embedding",
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
