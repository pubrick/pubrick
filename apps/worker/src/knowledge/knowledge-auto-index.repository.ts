import { Injectable } from "@nestjs/common";
import { KNOWLEDGE_EMBEDDING_DIMENSIONS, KNOWLEDGE_EMBEDDING_MODEL } from "@pubrick/ai";
import { schema } from "@pubrick/db";
import { decryptJson, parseStoredAiCredential } from "@pubrick/shared";
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { db, pool } from "../db";
import { env } from "../env";

export const AUTO_INDEX_BATCH_SIZE = 10;
export const AUTO_INDEX_BRANDS_PER_SCAN = 10;
export const AUTO_INDEX_COOLDOWN_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class KnowledgeAutoIndexRepository {
  /** One global cron pass is bounded to ten eligible brands. */
  candidates(now: Date) {
    return (
      db
        .select({
          orgId: schema.knowledgeAutoIndex.orgId,
          brandId: schema.knowledgeAutoIndex.brandId,
        })
        .from(schema.knowledgeAutoIndex)
        // A brand without a Google key is not an attempt: adding a key later
        // should make its first batch eligible on the next hourly scan.
        .innerJoin(
          schema.aiCredentials,
          and(
            eq(schema.aiCredentials.orgId, schema.knowledgeAutoIndex.orgId),
            eq(schema.aiCredentials.provider, "google"),
          ),
        )
        .where(
          and(
            eq(schema.knowledgeAutoIndex.enabled, true),
            or(
              isNull(schema.knowledgeAutoIndex.lastAttemptAt),
              lte(
                schema.knowledgeAutoIndex.lastAttemptAt,
                new Date(now.getTime() - AUTO_INDEX_COOLDOWN_MS),
              ),
            ),
            sql`exists (select 1 from knowledge_entries ke where ke.org_id = ${schema.knowledgeAutoIndex.orgId}
          and ke.brand_id = ${schema.knowledgeAutoIndex.brandId}
          and ke.is_active = true and ke.embedding is null)`,
          ),
        )
        .orderBy(
          asc(schema.knowledgeAutoIndex.lastAttemptAt),
          asc(schema.knowledgeAutoIndex.brandId),
        )
        .limit(AUTO_INDEX_BRANDS_PER_SCAN)
    );
  }

  /** Same session lock as the manual API path, held across the provider call. */
  async withIndexLock<T>(orgId: string, brandId: string, run: () => Promise<T>): Promise<T | null> {
    const client = await pool.connect();
    const key = `knowledge:${orgId}:${brandId}`;
    let discardConnection = false;
    try {
      const lock = await client.query<{ acquired: boolean }>(
        "select pg_try_advisory_lock(hashtextextended($1, 0)) as acquired",
        [key],
      );
      if (!lock.rows[0]?.acquired) return null;
      try {
        return await run();
      } finally {
        try {
          await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]);
        } catch {
          discardConnection = true;
        }
      }
    } finally {
      client.release(discardConnection);
    }
  }

  /** Durable claim is written before I/O; unknown provider outcomes cannot immediately repeat. */
  async claim(orgId: string, brandId: string, now: Date) {
    const rows = await db
      .update(schema.knowledgeAutoIndex)
      .set({ lastAttemptAt: now })
      .where(
        and(
          eq(schema.knowledgeAutoIndex.orgId, orgId),
          eq(schema.knowledgeAutoIndex.brandId, brandId),
          eq(schema.knowledgeAutoIndex.enabled, true),
          or(
            isNull(schema.knowledgeAutoIndex.lastAttemptAt),
            lte(
              schema.knowledgeAutoIndex.lastAttemptAt,
              new Date(now.getTime() - AUTO_INDEX_COOLDOWN_MS),
            ),
          ),
        ),
      )
      .returning({ brandId: schema.knowledgeAutoIndex.brandId });
    return rows.length === 1;
  }

  unindexed(orgId: string, brandId: string) {
    return db
      .select({
        id: schema.knowledgeEntries.id,
        title: schema.knowledgeEntries.title,
        content: schema.knowledgeEntries.content,
        revision: sql<string>`xmin::text`,
      })
      .from(schema.knowledgeEntries)
      .where(
        and(
          eq(schema.knowledgeEntries.orgId, orgId),
          eq(schema.knowledgeEntries.brandId, brandId),
          eq(schema.knowledgeEntries.isActive, true),
          isNull(schema.knowledgeEntries.embedding),
        ),
      )
      .orderBy(asc(schema.knowledgeEntries.createdAt), asc(schema.knowledgeEntries.id))
      .limit(AUTO_INDEX_BATCH_SIZE);
  }

  async googleKey(orgId: string) {
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

  async recordUsage(
    orgId: string,
    tokens: number,
    responseMs: number,
    status: "ok" | "errored",
    outcome: "completed" | "refused" | "unknown",
  ) {
    await db.insert(schema.usageLedger).values({
      orgId,
      step: "knowledge_batch_index",
      provider: "google",
      modelId: KNOWLEDGE_EMBEDDING_MODEL,
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

  async saveVector(
    orgId: string,
    brandId: string,
    entry: { id: string; title: string; content: string; revision: string },
    vector: number[],
  ) {
    const rows = await db
      .update(schema.knowledgeEntries)
      .set({
        embedding: vector,
        embeddingModel: KNOWLEDGE_EMBEDDING_MODEL,
        embeddingDimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
      })
      .where(
        and(
          eq(schema.knowledgeEntries.orgId, orgId),
          eq(schema.knowledgeEntries.brandId, brandId),
          eq(schema.knowledgeEntries.id, entry.id),
          eq(schema.knowledgeEntries.title, entry.title),
          eq(schema.knowledgeEntries.content, entry.content),
          sql`xmin::text = ${entry.revision}`,
          eq(schema.knowledgeEntries.isActive, true),
          isNull(schema.knowledgeEntries.embedding),
        ),
      )
      .returning({ id: schema.knowledgeEntries.id });
    return rows.length === 1;
  }
}
