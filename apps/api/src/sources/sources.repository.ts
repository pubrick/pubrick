import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  type NewsSourceCreate,
  type NewsSourceUpdate,
  newsSourceCreateSchema,
} from "@pubrick/shared";
import { and, desc, eq } from "drizzle-orm";
import { notFound } from "../api-error";
import { db } from "../db";
import { QueueService } from "../queue/queue.service";

const SOURCE_COLUMNS = {
  id: schema.newsSources.id,
  brandId: schema.newsSources.brandId,
  name: schema.newsSources.name,
  kind: schema.newsSources.kind,
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
  commentsStatus: schema.newsItems.commentsStatus,
  commentsCheckedAt: schema.newsItems.commentsCheckedAt,
  commentsErrorCode: schema.newsItems.commentsErrorCode,
  createdAt: schema.newsItems.createdAt,
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

  async telegramConnection(orgId: string): Promise<{ connected: boolean }> {
    const rows = await db
      .select({ orgId: schema.telegramSourceAccounts.orgId })
      .from(schema.telegramSourceAccounts)
      .where(eq(schema.telegramSourceAccounts.orgId, orgId))
      .limit(1);
    return { connected: rows.length > 0 };
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
      if (!source) throw new ConflictException("This source is already watched for the brand");
      await this.queue.enqueueRssPoll(tx, { orgId, sourceId: source.id });
      return source;
    });
  }

  async update(orgId: string, brandId: string, id: string, data: NewsSourceUpdate) {
    return db.transaction(async (tx) => {
      const existing = await tx
        .select(SOURCE_COLUMNS)
        .from(schema.newsSources)
        .where(
          and(
            eq(schema.newsSources.orgId, orgId),
            eq(schema.newsSources.brandId, brandId),
            eq(schema.newsSources.id, id),
          ),
        )
        .for("update")
        .limit(1);
      const source = existing[0];
      if (!source) throw new NotFoundException("Source not found");
      if (data.url && !newsSourceCreateSchema.safeParse({ ...source, ...data, brandId }).success) {
        throw new BadRequestException("The URL does not match this source type");
      }
      const rows = await tx
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
      return rows[0];
    });
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

  async items(orgId: string, brandId: string) {
    await this.requireBrand(orgId, brandId);
    return db
      .select(ITEM_COLUMNS)
      .from(schema.newsItems)
      .where(and(eq(schema.newsItems.orgId, orgId), eq(schema.newsItems.brandId, brandId)))
      .orderBy(desc(schema.newsItems.publishedAt), desc(schema.newsItems.createdAt))
      .limit(100);
  }

  private async requireTelegramItem(orgId: string, brandId: string, itemId: string) {
    await this.requireBrand(orgId, brandId);
    const rows = await db
      .select({
        id: schema.newsItems.id,
        commentsCheckedAt: schema.newsItems.commentsCheckedAt,
        commentsStatus: schema.newsItems.commentsStatus,
        sourceKind: schema.newsSources.kind,
        sourceActive: schema.newsSources.isActive,
      })
      .from(schema.newsItems)
      .innerJoin(schema.newsSources, eq(schema.newsItems.sourceId, schema.newsSources.id))
      .where(
        and(
          eq(schema.newsItems.orgId, orgId),
          eq(schema.newsItems.brandId, brandId),
          eq(schema.newsItems.id, itemId),
          eq(schema.newsSources.orgId, orgId),
          eq(schema.newsSources.brandId, brandId),
        ),
      )
      .limit(1);
    const item = rows[0];
    if (!item) throw new NotFoundException("Story not found");
    if (item.sourceKind !== "telegram")
      throw new ConflictException("Comments are available for Telegram stories only");
    return item;
  }

  async comments(orgId: string, brandId: string, itemId: string) {
    await this.requireTelegramItem(orgId, brandId, itemId);
    return db
      .select({
        id: schema.newsComments.id,
        body: schema.newsComments.body,
        publishedAt: schema.newsComments.publishedAt,
      })
      .from(schema.newsComments)
      .where(
        and(
          eq(schema.newsComments.orgId, orgId),
          eq(schema.newsComments.brandId, brandId),
          eq(schema.newsComments.itemId, itemId),
        ),
      )
      .orderBy(desc(schema.newsComments.publishedAt))
      .limit(50);
  }

  async refreshComments(orgId: string, brandId: string, itemId: string) {
    const item = await this.requireTelegramItem(orgId, brandId, itemId);
    if (!item.sourceActive)
      throw new ConflictException("Enable this source before collecting comments");
    if (item.commentsCheckedAt && Date.now() - item.commentsCheckedAt.getTime() < 15 * 60_000)
      return { queued: false };
    return db.transaction(async (tx) => {
      const queued = await this.queue.enqueueTelegramComments(tx, { orgId, itemId });
      if (queued)
        await tx
          .update(schema.newsItems)
          .set({ commentsStatus: "pending", commentsErrorCode: null })
          .where(
            and(
              eq(schema.newsItems.orgId, orgId),
              eq(schema.newsItems.brandId, brandId),
              eq(schema.newsItems.id, itemId),
            ),
          );
      return { queued };
    });
  }
}
