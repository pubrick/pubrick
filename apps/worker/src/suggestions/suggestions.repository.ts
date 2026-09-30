import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { KNOWLEDGE_EMBEDDING_MODEL, type UsageRecord } from "@pubrick/ai";
import { newsRankScore, schema } from "@pubrick/db";
import {
  daysUntilMemorableDate,
  decryptJson,
  parseStoredAiCredential,
  toLedgerCostUsd,
} from "@pubrick/shared";
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { env } from "../env";
import { holdOrganization } from "../organization-lock";

export function topicKey(title: string): string {
  return createHash("sha256")
    .update(title.normalize("NFKC").toLocaleLowerCase("en").replace(/\s+/g, " ").trim())
    .digest("hex");
}

export type Suggestion = {
  title: string;
  description: string;
  newsItemId: string | null;
  editorialPlaceholderId?: string | null;
  memorableDateId?: string | null;
};

type CalendarSignals = {
  placeholders: Array<{
    id: string;
    date: string;
    platform: string | null;
    contentType: string | null;
    timeOfDay: string | null;
  }>;
  memorable: Array<{
    id: string;
    title: string;
    date: string;
    daysUntil: number;
    suggestedContentTypes: string[];
  }>;
};

const DAY_MS = 86_400_000;
const PLACEHOLDER_HORIZON_DAYS = 14;
const MEMORABLE_HORIZON_DAYS = 28;

function addCalendarDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);
}

export function brandLocalDay(now: Date, timezone: string | null): string {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// Three proposal titles and all twenty recent reviewer blocks fit in three
// ten-text embedding calls. Overflow refuses a semantic request before AI spend.
export const BLOCKED_TOPIC_LIMIT = 20;
export const BLOCKED_TOPIC_EMBEDDING_CALL_LIMIT = 3;
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
        semanticFilterBlockedTopics: schema.topicSuggestionRequests.semanticFilterBlockedTopics,
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
    const [config] = await db
      .select({ timezone: schema.autopilotConfigs.timezone })
      .from(schema.autopilotConfigs)
      .where(
        and(eq(schema.autopilotConfigs.orgId, orgId), eq(schema.autopilotConfigs.brandId, brandId)),
      )
      .limit(1);
    const calendarToday = brandLocalDay(new Date(), config?.timezone ?? null);
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
          isNull(schema.newsItems.dismissedAt),
          ne(schema.newsSources.kind, "telegram_private"),
          ne(schema.newsSources.kind, "telegram_group"),
        ),
      )
      .orderBy(desc(newsRankScore), desc(schema.newsItems.createdAt))
      .limit(40);
    const placeholders = await db
      .select({
        id: schema.editorialPlaceholders.id,
        date: schema.editorialPlaceholders.date,
        platform: schema.editorialPlaceholders.platform,
        contentType: schema.editorialPlaceholders.contentType,
        timeOfDay: schema.editorialPlaceholders.timeOfDay,
      })
      .from(schema.editorialPlaceholders)
      .where(
        and(
          eq(schema.editorialPlaceholders.orgId, orgId),
          eq(schema.editorialPlaceholders.brandId, brandId),
          gte(schema.editorialPlaceholders.date, calendarToday),
          lt(
            schema.editorialPlaceholders.date,
            addCalendarDays(calendarToday, PLACEHOLDER_HORIZON_DAYS),
          ),
        ),
      )
      .orderBy(asc(schema.editorialPlaceholders.date), asc(schema.editorialPlaceholders.id))
      .limit(10);
    // Generate real calendar dates in PostgreSQL: Jan 1 sorts after Dec 31,
    // and Feb 29 exists only in leap years. Filter the lead window before
    // LIMIT so many out-of-window rows cannot hide eligible dates.
    const memorableRows = await db.execute<{
      id: string;
      month_day: string;
      title: string;
      suggested_content_types: string[];
      occurrence_date: string;
      days_until: number;
    }>(sql`
      SELECT d.id, d.month_day, d.title, d.suggested_content_types,
        (${calendarToday}::date + offsets.days)::text AS occurrence_date,
        offsets.days AS days_until
      FROM generate_series(0, ${MEMORABLE_HORIZON_DAYS}) AS offsets(days)
      JOIN memorable_dates d ON d.month_day = to_char(${calendarToday}::date + offsets.days, 'MM-DD')
      WHERE d.org_id = ${orgId} AND d.brand_id = ${brandId}
        AND d.is_active AND d.lead_days >= offsets.days
      ORDER BY offsets.days, d.id LIMIT 10
    `);
    const memorable = memorableRows.rows
      .filter((row) => daysUntilMemorableDate(row.month_day, calendarToday) === row.days_until)
      .map((row) => ({
        id: row.id,
        title: row.title,
        date: row.occurrence_date,
        daysUntil: row.days_until,
        suggestedContentTypes: row.suggested_content_types,
      }));
    return {
      origin: claimed[0].origin,
      localDate: claimed[0].localDate,
      semanticFilterBlockedTopics: claimed[0].semanticFilterBlockedTopics,
      attempt: claimed[0].attempts,
      brand: brands[0],
      calendarToday,
      calendar: { placeholders, memorable },
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
      .limit(BLOCKED_TOPIC_LIMIT + 1);
    if (rows.length > BLOCKED_TOPIC_LIMIT) return null;
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

  async googleProxy(orgId: string): Promise<string | undefined> {
    const [row] = await db
      .select({ encrypted: schema.aiCredentials.credentialsEncrypted })
      .from(schema.aiCredentials)
      .where(
        and(eq(schema.aiCredentials.orgId, orgId), eq(schema.aiCredentials.provider, "google")),
      )
      .limit(1);
    return row
      ? parseStoredAiCredential(decryptJson(row.encrypted, env.APP_ENCRYPTION_KEY)).proxyUrl
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
    news: Array<{ id: string; url: string; title: string }>,
    expectedAttempt?: number,
    blockedSnapshot?: BlockedTopicSnapshot,
    calendar: CalendarSignals = { placeholders: [], memorable: [] },
  ) {
    return db.transaction(async (tx) => {
      if (!(await holdOrganization(tx, orgId))) return 0;
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
          .limit(BLOCKED_TOPIC_LIMIT + 1);
        if (
          current.length > BLOCKED_TOPIC_LIMIT ||
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
      const allowedNews = new Map(news.map((item) => [item.id, item]));
      const allowedPlaceholders = new Map(calendar.placeholders.map((item) => [item.id, item]));
      const allowedMemorable = new Map(calendar.memorable.map((item) => [item.id, item]));
      let count = 0;
      for (const suggestion of suggestions.slice(0, 3)) {
        const key = topicKey(suggestion.title);
        if (seen.has(key)) continue;
        const references = [
          suggestion.newsItemId,
          suggestion.editorialPlaceholderId,
          suggestion.memorableDateId,
        ].filter((id) => id !== null && id !== undefined);
        if (references.length > 1) continue;
        const newsItem =
          suggestion.newsItemId != null ? allowedNews.get(suggestion.newsItemId) : undefined;
        const placeholder =
          suggestion.editorialPlaceholderId != null
            ? allowedPlaceholders.get(suggestion.editorialPlaceholderId)
            : undefined;
        const memorableDate =
          suggestion.memorableDateId != null
            ? allowedMemorable.get(suggestion.memorableDateId)
            : undefined;
        if (suggestion.newsItemId != null && !newsItem?.title.trim()) continue;
        if (suggestion.editorialPlaceholderId != null && !placeholder) continue;
        if (suggestion.memorableDateId != null && !memorableDate) continue;
        seen.add(key);
        const inspirationKind = newsItem
          ? "news"
          : placeholder
            ? "editorial_placeholder"
            : memorableDate
              ? "memorable_date"
              : "none";
        const inspirationRefId = newsItem?.id ?? placeholder?.id ?? memorableDate?.id ?? null;
        const inspirationLabel =
          newsItem?.title.slice(0, 500) ??
          memorableDate?.title.slice(0, 500) ??
          (placeholder ? "Editorial opening" : null);
        const inspirationDate = placeholder?.date ?? memorableDate?.date ?? null;
        const rows = await tx
          .insert(schema.topics)
          .values({
            orgId,
            brandId,
            title: suggestion.title,
            description: suggestion.description,
            sourceUrl: newsItem?.url ?? null,
            inspirationKind,
            inspirationRefId,
            inspirationLabel,
            inspirationDate,
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
    code: "configuration_changed" | "no_api_key" | "unreadable_key" | "model_failed",
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
