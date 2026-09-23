import { randomBytes } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import { badRequest, notFound } from "../api-error";
import { db } from "../db";
import { env } from "../env";

const ENTRY_COLUMNS = {
  id: schema.feedEntries.id,
  contentItemId: schema.feedEntries.contentItemId,
  title: schema.feedEntries.title,
  publishedAt: schema.feedEntries.publishedAt,
};

/** This origin is configured at boot; request Host headers cannot forge public links. */
function publicUrl(orgId: string, token: string): string {
  return `${env.WEB_ORIGIN.replace(/\/$/, "")}/api/feeds/${encodeURIComponent(orgId)}/${token}/rss`;
}

@Injectable()
export class FeedsRepository {
  private async feed(orgId: string, brandId: string) {
    const rows = await db
      .select({ id: schema.brandFeeds.id, publicToken: schema.brandFeeds.publicToken })
      .from(schema.brandFeeds)
      .where(and(eq(schema.brandFeeds.orgId, orgId), eq(schema.brandFeeds.brandId, brandId)))
      .limit(1);
    return rows[0] ?? null;
  }

  async get(orgId: string, brandId: string) {
    const feed = await this.feed(orgId, brandId);
    if (!feed) return { enabled: false, url: null, entries: [] };
    const entries = await db
      .select(ENTRY_COLUMNS)
      .from(schema.feedEntries)
      .where(and(eq(schema.feedEntries.orgId, orgId), eq(schema.feedEntries.feedId, feed.id)))
      .orderBy(desc(schema.feedEntries.publishedAt), desc(schema.feedEntries.id));
    return { enabled: true, url: publicUrl(orgId, feed.publicToken), entries };
  }

  async enable(orgId: string, brandId: string) {
    const brand = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    if (brand.length === 0) throw notFound("brand_not_found", "Brand not found");
    await db
      .insert(schema.brandFeeds)
      .values({ orgId, brandId, publicToken: randomBytes(24).toString("base64url") })
      .onConflictDoNothing({ target: schema.brandFeeds.brandId });
    return this.get(orgId, brandId);
  }

  async disable(orgId: string, brandId: string) {
    await db
      .delete(schema.brandFeeds)
      .where(and(eq(schema.brandFeeds.orgId, orgId), eq(schema.brandFeeds.brandId, brandId)));
    return { enabled: false, url: null, entries: [] };
  }

  async add(orgId: string, brandId: string, itemId: string) {
    const feed = await this.feed(orgId, brandId);
    if (!feed) throw notFound("feed_not_found", "Enable the public feed first");
    const items = await db
      .select({
        id: schema.contentItems.id,
        title: schema.contentItems.title,
        body: schema.contentItems.body,
      })
      .from(schema.contentItems)
      .where(
        and(
          eq(schema.contentItems.orgId, orgId),
          eq(schema.contentItems.brandId, brandId),
          eq(schema.contentItems.id, itemId),
          inArray(schema.contentItems.status, ["published", "partially_published"]),
        ),
      )
      .limit(1);
    const item = items[0];
    if (!item?.title?.trim() || !item.body.trim()) {
      throw badRequest(
        "feed_item_not_ready",
        "Only titled, published posts can be added to a public feed",
      );
    }
    await db
      .insert(schema.feedEntries)
      .values({
        orgId,
        feedId: feed.id,
        contentItemId: item.id,
        title: item.title,
        body: item.body,
      })
      .onConflictDoNothing({
        target: [schema.feedEntries.feedId, schema.feedEntries.contentItemId],
      });
    return this.get(orgId, brandId);
  }

  async remove(orgId: string, brandId: string, itemId: string) {
    const feed = await this.feed(orgId, brandId);
    if (!feed) throw notFound("feed_not_found", "Public feed not found");
    await db
      .delete(schema.feedEntries)
      .where(
        and(
          eq(schema.feedEntries.orgId, orgId),
          eq(schema.feedEntries.feedId, feed.id),
          eq(schema.feedEntries.contentItemId, itemId),
        ),
      );
    return this.get(orgId, brandId);
  }

  async publicFeed(orgId: string, token: string) {
    const rows = await db
      .select({
        id: schema.brandFeeds.id,
        brandName: schema.brands.name,
        brandDescription: schema.brands.description,
        language: schema.brands.contentLanguage,
      })
      .from(schema.brandFeeds)
      .innerJoin(schema.brands, eq(schema.brandFeeds.brandId, schema.brands.id))
      .where(
        and(
          eq(schema.brandFeeds.orgId, orgId),
          eq(schema.brands.orgId, orgId),
          eq(schema.brandFeeds.publicToken, token),
        ),
      )
      .limit(1);
    const feed = rows[0];
    if (!feed) throw notFound("feed_not_found", "Public feed not found");
    const entries = await db
      .select({
        id: schema.feedEntries.id,
        title: schema.feedEntries.title,
        body: schema.feedEntries.body,
        publishedAt: schema.feedEntries.publishedAt,
      })
      .from(schema.feedEntries)
      .where(and(eq(schema.feedEntries.orgId, orgId), eq(schema.feedEntries.feedId, feed.id)))
      .orderBy(desc(schema.feedEntries.publishedAt), desc(schema.feedEntries.id))
      .limit(50);
    return { ...feed, url: publicUrl(orgId, token), entries };
  }

  async publicArticle(orgId: string, token: string, entryId: string) {
    const rows = await db
      .select({
        title: schema.feedEntries.title,
        body: schema.feedEntries.body,
        publishedAt: schema.feedEntries.publishedAt,
        brandName: schema.brands.name,
        language: schema.brands.contentLanguage,
      })
      .from(schema.feedEntries)
      .innerJoin(schema.brandFeeds, eq(schema.feedEntries.feedId, schema.brandFeeds.id))
      .innerJoin(schema.brands, eq(schema.brandFeeds.brandId, schema.brands.id))
      .where(
        and(
          eq(schema.feedEntries.orgId, orgId),
          eq(schema.brandFeeds.orgId, orgId),
          eq(schema.brands.orgId, orgId),
          eq(schema.brandFeeds.publicToken, token),
          eq(schema.feedEntries.id, entryId),
        ),
      )
      .limit(1);
    const article = rows[0];
    if (!article) throw notFound("feed_not_found", "Public article not found");
    return article;
  }
}
