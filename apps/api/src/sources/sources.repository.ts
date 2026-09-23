import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { schema } from "@pubrick/db";
import type { NewsItemListQuery, NewsSourceCreate, NewsSourceUpdate } from "@pubrick/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { notFound } from "../api-error";
import { db } from "../db";
import { QueueService } from "../queue/queue.service";

const SOURCE_COLUMNS = {
  id: schema.newsSources.id,
  brandId: schema.newsSources.brandId,
  name: schema.newsSources.name,
  url: schema.newsSources.url,
  isActive: schema.newsSources.isActive,
  checkIntervalMinutes: schema.newsSources.checkIntervalMinutes,
  lastCheckedAt: schema.newsSources.lastCheckedAt,
  lastErrorCode: schema.newsSources.lastErrorCode,
  createdAt: schema.newsSources.createdAt,
  updatedAt: schema.newsSources.updatedAt,
};

const ITEM_COLUMNS = {
  id: schema.newsItems.id,
  brandId: schema.newsItems.brandId,
  sourceId: schema.newsItems.sourceId,
  title: schema.newsItems.title,
  summary: schema.newsItems.summary,
  url: schema.newsItems.url,
  publishedAt: schema.newsItems.publishedAt,
  createdAt: schema.newsItems.createdAt,
  editorSignal: schema.newsItems.editorSignal,
  relevanceStatus: schema.newsItems.relevanceStatus,
  relevanceScore: schema.newsItems.relevanceScore,
  relevanceReason: schema.newsItems.relevanceReason,
  relevanceUrgency: schema.newsItems.relevanceUrgency,
  relevanceErrorCode: schema.newsItems.relevanceErrorCode,
  relevanceScoredAt: schema.newsItems.relevanceScoredAt,
};

@Injectable()
export class SourcesRepository {
  constructor(private readonly queue: QueueService) {}

  private async requireBrand(orgId: string, brandId: string) {
    const rows = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    if (!rows.length) throw notFound("brand_not_found", "Brand not found");
  }

  async list(orgId: string, brandId: string) {
    await this.requireBrand(orgId, brandId);
    return db
      .select(SOURCE_COLUMNS)
      .from(schema.newsSources)
      .where(and(eq(schema.newsSources.orgId, orgId), eq(schema.newsSources.brandId, brandId)))
      .orderBy(desc(schema.newsSources.createdAt));
  }

  async create(orgId: string, data: NewsSourceCreate) {
    await this.requireBrand(orgId, data.brandId);
    return db.transaction(async (tx) => {
      const rows = await tx
        .insert(schema.newsSources)
        .values({ ...data, orgId })
        .onConflictDoNothing()
        .returning(SOURCE_COLUMNS);
      const source = rows[0];
      if (!source) throw new ConflictException("This feed is already watched for the brand");
      await this.queue.enqueueRssPoll(tx, { orgId, sourceId: source.id });
      return source;
    });
  }

  async update(orgId: string, brandId: string, id: string, data: NewsSourceUpdate) {
    const rows = await db
      .update(schema.newsSources)
      .set({ ...data, updatedAt: new Date() })
      .where(
        and(
          eq(schema.newsSources.orgId, orgId),
          eq(schema.newsSources.brandId, brandId),
          eq(schema.newsSources.id, id),
        ),
      )
      .returning(SOURCE_COLUMNS);
    if (!rows.length) throw new NotFoundException("RSS source not found");
    return rows[0];
  }

  async delete(orgId: string, brandId: string, id: string) {
    const rows = await db
      .delete(schema.newsSources)
      .where(
        and(
          eq(schema.newsSources.orgId, orgId),
          eq(schema.newsSources.brandId, brandId),
          eq(schema.newsSources.id, id),
        ),
      )
      .returning({ id: schema.newsSources.id });
    if (!rows.length) throw new NotFoundException("RSS source not found");
    return { ok: true };
  }

  async refresh(orgId: string, brandId: string, id: string) {
    return db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: schema.newsSources.id, isActive: schema.newsSources.isActive })
        .from(schema.newsSources)
        .where(
          and(
            eq(schema.newsSources.orgId, orgId),
            eq(schema.newsSources.brandId, brandId),
            eq(schema.newsSources.id, id),
          ),
        )
        .limit(1);
      const source = rows[0];
      if (!source) throw new NotFoundException("RSS source not found");
      if (!source.isActive) throw new ConflictException("Enable this source before refreshing it");
      const queued = await this.queue.enqueueRssPoll(tx, { orgId, sourceId: id });
      return { queued };
    });
  }

  async items(orgId: string, query: NewsItemListQuery) {
    await this.requireBrand(orgId, query.brandId);
    return db
      .select(ITEM_COLUMNS)
      .from(schema.newsItems)
      .where(
        and(
          eq(schema.newsItems.orgId, orgId),
          eq(schema.newsItems.brandId, query.brandId),
          ...(query.status === "all" ? [] : [eq(schema.newsItems.relevanceStatus, query.status)]),
        ),
      )
      .orderBy(
        ...(query.sort === "relevance"
          ? [sql`${schema.newsItems.relevanceScore} DESC NULLS LAST`]
          : [desc(schema.newsItems.publishedAt)]),
        desc(schema.newsItems.createdAt),
        desc(schema.newsItems.id),
      )
      .limit(100);
  }

  async score(orgId: string, brandId: string, id: string) {
    return db.transaction(async (tx) => {
      const rows = await tx
        .select({
          id: schema.newsItems.id,
          relevanceStatus: schema.newsItems.relevanceStatus,
        })
        .from(schema.newsItems)
        .where(
          and(
            eq(schema.newsItems.orgId, orgId),
            eq(schema.newsItems.brandId, brandId),
            eq(schema.newsItems.id, id),
          ),
        )
        .limit(1);
      const item = rows[0];
      if (!item) throw new NotFoundException("Article not found");
      if (item.relevanceStatus === "scored")
        throw new ConflictException("Article is already scored");
      if (item.relevanceStatus === "failed") {
        await tx
          .update(schema.newsItems)
          .set({ relevanceAttempts: 0 })
          .where(
            and(
              eq(schema.newsItems.orgId, orgId),
              eq(schema.newsItems.brandId, brandId),
              eq(schema.newsItems.id, id),
            ),
          );
      }
      const queued = await this.queue.enqueueRelevance(tx, { orgId, brandId, itemId: id });
      return { queued };
    });
  }
}
