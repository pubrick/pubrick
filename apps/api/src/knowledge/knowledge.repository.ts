import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  decryptJson,
  type KnowledgeCreate,
  type KnowledgeImport,
  type KnowledgeUpdate,
  parseStoredAiCredential,
} from "@pubrick/shared";
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { notFound } from "../api-error";
import { db, pool } from "../db";
import { env } from "../env";

const PUBLIC_COLUMNS = {
  id: schema.knowledgeEntries.id,
  brandId: schema.knowledgeEntries.brandId,
  title: schema.knowledgeEntries.title,
  content: schema.knowledgeEntries.content,
  category: schema.knowledgeEntries.category,
  tags: schema.knowledgeEntries.tags,
  isActive: schema.knowledgeEntries.isActive,
  hasEmbedding: isNotNull(schema.knowledgeEntries.embedding),
  createdAt: schema.knowledgeEntries.createdAt,
  updatedAt: schema.knowledgeEntries.updatedAt,
};

@Injectable()
export class KnowledgeRepository {
  /** A session lock spans the provider call and all writes, including other API instances. */
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
          // An uncertain unlock must never return a locked session to the pool.
          discardConnection = true;
        }
      }
    } finally {
      client.release(discardConnection);
    }
  }

  async unindexed(orgId: string, brandId: string, limit: number) {
    const [brand] = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    if (!brand) throw notFound("brand_not_found", "Brand not found");
    return db
      .select({
        id: schema.knowledgeEntries.id,
        title: schema.knowledgeEntries.title,
        content: schema.knowledgeEntries.content,
        // PostgreSQL's row version detects even edit-then-revert while Google runs.
        // `updated_at` loses sub-millisecond precision when decoded into a JS Date.
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
      .limit(limit);
  }

  async unindexedCount(orgId: string, brandId: string) {
    const [brand] = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    if (!brand) throw notFound("brand_not_found", "Brand not found");
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.knowledgeEntries)
      .where(
        and(
          eq(schema.knowledgeEntries.orgId, orgId),
          eq(schema.knowledgeEntries.brandId, brandId),
          eq(schema.knowledgeEntries.isActive, true),
          isNull(schema.knowledgeEntries.embedding),
        ),
      );
    return row?.count ?? 0;
  }

  async setBatchEmbedding(
    orgId: string,
    brandId: string,
    entry: {
      id: string;
      title: string;
      content: string;
      revision: string;
    },
    embedding: number[],
  ) {
    const rows = await db
      .update(schema.knowledgeEntries)
      .set({ embedding })
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
  list(orgId: string, brandId: string) {
    return db
      .select(PUBLIC_COLUMNS)
      .from(schema.knowledgeEntries)
      .where(
        and(eq(schema.knowledgeEntries.orgId, orgId), eq(schema.knowledgeEntries.brandId, brandId)),
      )
      .orderBy(desc(schema.knowledgeEntries.createdAt), desc(schema.knowledgeEntries.id));
  }

  async create(orgId: string, data: KnowledgeCreate) {
    const brand = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, data.brandId)))
      .limit(1);
    if (!brand[0]) throw notFound("brand_not_found", "Brand not found");
    const [entry] = await db
      .insert(schema.knowledgeEntries)
      .values({ ...data, orgId })
      .returning(PUBLIC_COLUMNS);
    return entry;
  }

  /** One atomic insert: a malformed row never creates a misleading partial import. */
  async import(orgId: string, data: KnowledgeImport) {
    return db.transaction(async (tx) => {
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, data.brandId)))
        .limit(1)
        .for("key share");
      if (!brand) throw notFound("brand_not_found", "Brand not found");
      const rows = await tx
        .insert(schema.knowledgeEntries)
        .values(data.entries.map((entry) => ({ ...entry, brandId: data.brandId, orgId })))
        .returning({ id: schema.knowledgeEntries.id });
      return { created: rows.length, ids: rows.map((row) => row.id) };
    });
  }

  async get(orgId: string, brandId: string, id: string) {
    const [entry] = await db
      .select(PUBLIC_COLUMNS)
      .from(schema.knowledgeEntries)
      .where(
        and(
          eq(schema.knowledgeEntries.orgId, orgId),
          eq(schema.knowledgeEntries.brandId, brandId),
          eq(schema.knowledgeEntries.id, id),
        ),
      )
      .limit(1);
    if (!entry) throw notFound("knowledge_not_found", "Knowledge entry not found");
    return entry;
  }

  async update(orgId: string, brandId: string, id: string, data: KnowledgeUpdate) {
    const textChanged = data.title !== undefined || data.content !== undefined;
    const [entry] = await db
      .update(schema.knowledgeEntries)
      .set({ ...data, ...(textChanged ? { embedding: null } : {}) })
      .where(
        and(
          eq(schema.knowledgeEntries.orgId, orgId),
          eq(schema.knowledgeEntries.brandId, brandId),
          eq(schema.knowledgeEntries.id, id),
        ),
      )
      .returning(PUBLIC_COLUMNS);
    if (!entry) throw notFound("knowledge_not_found", "Knowledge entry not found");
    return entry;
  }

  async delete(orgId: string, brandId: string, id: string) {
    const rows = await db
      .delete(schema.knowledgeEntries)
      .where(
        and(
          eq(schema.knowledgeEntries.orgId, orgId),
          eq(schema.knowledgeEntries.brandId, brandId),
          eq(schema.knowledgeEntries.id, id),
        ),
      )
      .returning({ id: schema.knowledgeEntries.id });
    if (!rows[0]) throw notFound("knowledge_not_found", "Knowledge entry not found");
    return { deleted: true };
  }

  async indexInput(orgId: string, brandId: string, id: string) {
    const [entry] = await db
      .select({
        id: schema.knowledgeEntries.id,
        title: schema.knowledgeEntries.title,
        content: schema.knowledgeEntries.content,
      })
      .from(schema.knowledgeEntries)
      .where(
        and(
          eq(schema.knowledgeEntries.orgId, orgId),
          eq(schema.knowledgeEntries.brandId, brandId),
          eq(schema.knowledgeEntries.id, id),
        ),
      )
      .limit(1);
    if (!entry) throw notFound("knowledge_not_found", "Knowledge entry not found");
    return entry;
  }

  /** A concurrent edit cannot attach a vector for the previous text. */
  async setEmbedding(
    orgId: string,
    brandId: string,
    id: string,
    title: string,
    content: string,
    embedding: number[],
  ) {
    const [entry] = await db
      .update(schema.knowledgeEntries)
      .set({ embedding })
      .where(
        and(
          eq(schema.knowledgeEntries.orgId, orgId),
          eq(schema.knowledgeEntries.brandId, brandId),
          eq(schema.knowledgeEntries.id, id),
          eq(schema.knowledgeEntries.title, title),
          eq(schema.knowledgeEntries.content, content),
        ),
      )
      .returning(PUBLIC_COLUMNS);
    return entry;
  }

  async googleKey(orgId: string): Promise<string | undefined> {
    const [row] = await db
      .select({ encrypted: schema.aiCredentials.credentialsEncrypted })
      .from(schema.aiCredentials)
      .where(
        and(eq(schema.aiCredentials.orgId, orgId), eq(schema.aiCredentials.provider, "google")),
      )
      .limit(1);
    if (!row) return undefined;
    return parseStoredAiCredential(decryptJson(row.encrypted, env.APP_ENCRYPTION_KEY)).apiKey;
  }

  async recordEmbeddingUsage(
    orgId: string,
    tokens: number,
    responseMs: number,
    status: "ok" | "errored",
    outcome: "completed" | "refused" | "unknown",
    step: "knowledge_index" | "knowledge_batch_index" = "knowledge_index",
  ) {
    await db.insert(schema.usageLedger).values({
      orgId,
      step,
      provider: "google",
      modelId: "gemini-embedding-001",
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
