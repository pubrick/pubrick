import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { and, asc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import type { FeedItem } from "./rss.fetcher";

@Injectable()
export class RssRepository {
  async get(orgId: string, sourceId: string) {
    const rows = await db
      .select({
        id: schema.newsSources.id,
        orgId: schema.newsSources.orgId,
        brandId: schema.newsSources.brandId,
        url: schema.newsSources.url,
        isActive: schema.newsSources.isActive,
      })
      .from(schema.newsSources)
      .where(and(eq(schema.newsSources.orgId, orgId), eq(schema.newsSources.id, sourceId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /** Privileged scheduler scan across tenants; job handling is scoped by orgId. */
  due(afterId?: string) {
    return db
      .select({ orgId: schema.newsSources.orgId, sourceId: schema.newsSources.id })
      .from(schema.newsSources)
      .where(
        and(
          eq(schema.newsSources.isActive, true),
          ...(afterId ? [gt(schema.newsSources.id, afterId)] : []),
          or(
            isNull(schema.newsSources.lastCheckedAt),
            sql`${schema.newsSources.lastCheckedAt} + (${schema.newsSources.checkIntervalMinutes} * interval '1 minute') <= now()`,
          ),
        ),
      )
      .orderBy(asc(schema.newsSources.id))
      .limit(100);
  }

  async save(orgId: string, sourceId: string, feedUrl: string, items: FeedItem[]) {
    await db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: schema.newsSources.id, brandId: schema.newsSources.brandId })
        .from(schema.newsSources)
        .where(
          and(
            eq(schema.newsSources.orgId, orgId),
            eq(schema.newsSources.id, sourceId),
            eq(schema.newsSources.url, feedUrl),
            eq(schema.newsSources.isActive, true),
          ),
        )
        .for("update")
        .limit(1);
      const source = rows[0];
      if (!source) return;
      if (items.length) {
        await tx
          .insert(schema.newsItems)
          .values(
            items.map((item) => ({
              orgId,
              brandId: source.brandId,
              sourceId,
              ...item,
            })),
          )
          .onConflictDoNothing();
      }
      await tx
        .update(schema.newsSources)
        .set({ lastCheckedAt: new Date(), lastErrorCode: null, updatedAt: new Date() })
        .where(and(eq(schema.newsSources.orgId, orgId), eq(schema.newsSources.id, sourceId)));
    });
  }

  async fail(orgId: string, sourceId: string, feedUrl: string, code: string) {
    await db
      .update(schema.newsSources)
      .set({ lastCheckedAt: new Date(), lastErrorCode: code, updatedAt: new Date() })
      .where(
        and(
          eq(schema.newsSources.orgId, orgId),
          eq(schema.newsSources.id, sourceId),
          eq(schema.newsSources.url, feedUrl),
          eq(schema.newsSources.isActive, true),
        ),
      );
  }
}
