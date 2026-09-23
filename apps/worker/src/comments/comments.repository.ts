import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import type { ChannelComments } from "@pubrick/telegram";
import { and, eq } from "drizzle-orm";
import { db } from "../db";

@Injectable()
export class CommentsRepository {
  async item(orgId: string, itemId: string) {
    const rows = await db
      .select({
        id: schema.newsItems.id,
        orgId: schema.newsItems.orgId,
        brandId: schema.newsItems.brandId,
        url: schema.newsItems.url,
        sourceKind: schema.newsSources.kind,
      })
      .from(schema.newsItems)
      .innerJoin(schema.newsSources, eq(schema.newsItems.sourceId, schema.newsSources.id))
      .where(
        and(
          eq(schema.newsItems.orgId, orgId),
          eq(schema.newsItems.id, itemId),
          eq(schema.newsSources.orgId, orgId),
          eq(schema.newsSources.brandId, schema.newsItems.brandId),
        ),
      )
      .limit(1);
    const item = rows[0];
    return item?.sourceKind === "telegram" ? item : null;
  }

  async session(orgId: string): Promise<string | null> {
    const rows = await db
      .select({ encrypted: schema.telegramSourceAccounts.sessionEncrypted })
      .from(schema.telegramSourceAccounts)
      .where(eq(schema.telegramSourceAccounts.orgId, orgId))
      .limit(1);
    return rows[0]?.encrypted ?? null;
  }

  async save(
    orgId: string,
    itemId: string,
    itemUrl: string,
    result: ChannelComments,
  ): Promise<void> {
    await db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: schema.newsItems.id, brandId: schema.newsItems.brandId })
        .from(schema.newsItems)
        .where(
          and(
            eq(schema.newsItems.orgId, orgId),
            eq(schema.newsItems.id, itemId),
            eq(schema.newsItems.url, itemUrl),
          ),
        )
        .for("update")
        .limit(1);
      const item = rows[0];
      if (!item) return;
      await tx
        .delete(schema.newsComments)
        .where(and(eq(schema.newsComments.orgId, orgId), eq(schema.newsComments.itemId, itemId)));
      if (result.comments.length)
        await tx.insert(schema.newsComments).values(
          result.comments.map((comment) => ({
            orgId,
            brandId: item.brandId,
            itemId,
            telegramMessageId: comment.messageId,
            body: comment.body,
            publishedAt: comment.publishedAt,
          })),
        );
      await tx
        .update(schema.newsItems)
        .set({
          commentsStatus: result.status,
          commentsCheckedAt: new Date(),
          commentsErrorCode: null,
        })
        .where(and(eq(schema.newsItems.orgId, orgId), eq(schema.newsItems.id, itemId)));
    });
  }

  async fail(orgId: string, itemId: string, itemUrl: string, code: string): Promise<void> {
    await db
      .update(schema.newsItems)
      .set({ commentsStatus: "error", commentsCheckedAt: new Date(), commentsErrorCode: code })
      .where(
        and(
          eq(schema.newsItems.orgId, orgId),
          eq(schema.newsItems.id, itemId),
          eq(schema.newsItems.url, itemUrl),
        ),
      );
  }
}
