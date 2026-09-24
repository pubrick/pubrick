import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { isPublicTelegramPostUrl, type TelegramCommentsJob } from "@pubrick/shared";
import type { ChannelComments } from "@pubrick/telegram";
import { and, eq } from "drizzle-orm";
import { db } from "../db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

@Injectable()
export class CommentsRepository {
  /** Only a live publication with its original Telegram channel can be read. */
  async publication(orgId: string, brandId: string, publicationId: string) {
    const [row] = await db
      .select({
        id: schema.publications.id,
        adaptationId: schema.publications.adaptationId,
        channelId: schema.publications.channelId,
        contentItemId: schema.adaptations.contentItemId,
        url: schema.publications.externalUrl,
        externalId: schema.publications.externalId,
      })
      .from(schema.publications)
      .innerJoin(
        schema.adaptations,
        and(
          eq(schema.adaptations.id, schema.publications.adaptationId),
          eq(schema.adaptations.orgId, orgId),
        ),
      )
      .innerJoin(
        schema.contentItems,
        and(
          eq(schema.contentItems.id, schema.adaptations.contentItemId),
          eq(schema.contentItems.orgId, orgId),
          eq(schema.contentItems.brandId, brandId),
        ),
      )
      .innerJoin(
        schema.channels,
        and(
          eq(schema.channels.id, schema.adaptations.channelId),
          eq(schema.channels.id, schema.publications.channelId),
          eq(schema.channels.orgId, orgId),
          eq(schema.channels.brandId, brandId),
          eq(schema.channels.platform, "telegram"),
        ),
      )
      .where(
        and(
          eq(schema.publications.orgId, orgId),
          eq(schema.publications.id, publicationId),
          eq(schema.publications.status, "published"),
        ),
      )
      .limit(1);
    return row && isPublicTelegramPostUrl(row.url, row.externalId)
      ? {
          id: row.id,
          url: row.url,
          externalId: row.externalId,
          adaptationId: row.adaptationId,
          channelId: row.channelId,
          contentItemId: row.contentItemId,
        }
      : null;
  }

  private async lockLivePublication(
    tx: Tx,
    job: Extract<TelegramCommentsJob, { kind: "publication" }>,
    current: NonNullable<Awaited<ReturnType<CommentsRepository["publication"]>>>,
  ): Promise<boolean> {
    if (!current.adaptationId || !current.channelId || !current.externalId) return false;
    const [adaptation] = await tx
      .select({ id: schema.adaptations.id })
      .from(schema.adaptations)
      .where(
        and(
          eq(schema.adaptations.id, current.adaptationId),
          eq(schema.adaptations.orgId, job.orgId),
          eq(schema.adaptations.contentItemId, current.contentItemId),
          eq(schema.adaptations.channelId, current.channelId),
        ),
      )
      .limit(1)
      .for("share");
    if (!adaptation) return false;
    const [channel] = await tx
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.id, current.channelId),
          eq(schema.channels.orgId, job.orgId),
          eq(schema.channels.brandId, job.brandId),
          eq(schema.channels.platform, "telegram"),
        ),
      )
      .limit(1)
      .for("share");
    if (!channel) return false;
    const [item] = await tx
      .select({ id: schema.contentItems.id })
      .from(schema.contentItems)
      .where(
        and(
          eq(schema.contentItems.id, current.contentItemId),
          eq(schema.contentItems.orgId, job.orgId),
          eq(schema.contentItems.brandId, job.brandId),
        ),
      )
      .limit(1)
      .for("share");
    if (!item) return false;
    const [receipt] = await tx
      .select({ id: schema.publications.id })
      .from(schema.publications)
      .where(
        and(
          eq(schema.publications.id, current.id),
          eq(schema.publications.orgId, job.orgId),
          eq(schema.publications.status, "published"),
          eq(schema.publications.adaptationId, current.adaptationId),
          eq(schema.publications.channelId, current.channelId),
          eq(schema.publications.externalId, current.externalId),
          eq(schema.publications.externalUrl, current.url),
        ),
      )
      .limit(1)
      .for("share");
    return !!receipt;
  }

  async savePublication(
    job: Extract<TelegramCommentsJob, { kind: "publication" }>,
    url: string,
    result: ChannelComments,
  ) {
    const current = await this.publication(job.orgId, job.brandId, job.publicationId);
    if (!current || current.url !== url) return;
    await db.transaction(async (tx) => {
      const [organization] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, job.orgId))
        .limit(1)
        .for("key share");
      if (!organization) return;
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, job.orgId), eq(schema.brands.id, job.brandId)))
        .limit(1)
        .for("key share");
      if (!brand) return;
      if (!(await this.lockLivePublication(tx, job, current))) return;
      const [sample] = await tx
        .select({ requestedAt: schema.publicationCommentSamples.requestedAt })
        .from(schema.publicationCommentSamples)
        .where(
          and(
            eq(schema.publicationCommentSamples.orgId, job.orgId),
            eq(schema.publicationCommentSamples.brandId, job.brandId),
            eq(schema.publicationCommentSamples.publicationId, job.publicationId),
            eq(schema.publicationCommentSamples.status, "pending"),
          ),
        )
        .limit(1)
        .for("update");
      if (sample?.requestedAt.toISOString() !== job.requestedAt) return;
      const comments = result.comments.slice(0, 50);
      const status =
        result.status === "available"
          ? comments.length
            ? "available"
            : "no_comments"
          : "unavailable";
      if (result.status === "available") {
        await tx
          .delete(schema.publicationComments)
          .where(
            and(
              eq(schema.publicationComments.orgId, job.orgId),
              eq(schema.publicationComments.brandId, job.brandId),
              eq(schema.publicationComments.publicationId, job.publicationId),
            ),
          );
        if (comments.length)
          await tx.insert(schema.publicationComments).values(
            comments.map((comment) => ({
              orgId: job.orgId,
              brandId: job.brandId,
              publicationId: job.publicationId,
              telegramMessageId: comment.messageId,
              body: comment.body,
              publishedAt: comment.publishedAt,
            })),
          );
      }
      await tx
        .update(schema.publicationCommentSamples)
        .set({
          status,
          checkedAt: new Date(),
          errorCode: null,
        })
        .where(
          and(
            eq(schema.publicationCommentSamples.orgId, job.orgId),
            eq(schema.publicationCommentSamples.brandId, job.brandId),
            eq(schema.publicationCommentSamples.publicationId, job.publicationId),
          ),
        );
    });
  }

  async failPublication(
    job: Extract<TelegramCommentsJob, { kind: "publication" }>,
    url: string,
    code: string,
  ) {
    const current = await this.publication(job.orgId, job.brandId, job.publicationId);
    if (!current || current.url !== url) return;
    await db.transaction(async (tx) => {
      const [organization] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, job.orgId))
        .limit(1)
        .for("key share");
      if (!organization) return;
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, job.orgId), eq(schema.brands.id, job.brandId)))
        .limit(1)
        .for("key share");
      if (!brand) return;
      if (!(await this.lockLivePublication(tx, job, current))) return;
      const [sample] = await tx
        .select({ requestedAt: schema.publicationCommentSamples.requestedAt })
        .from(schema.publicationCommentSamples)
        .where(
          and(
            eq(schema.publicationCommentSamples.orgId, job.orgId),
            eq(schema.publicationCommentSamples.brandId, job.brandId),
            eq(schema.publicationCommentSamples.publicationId, job.publicationId),
            eq(schema.publicationCommentSamples.status, "pending"),
          ),
        )
        .limit(1)
        .for("update");
      if (sample?.requestedAt.toISOString() !== job.requestedAt) return;
      await tx
        .update(schema.publicationCommentSamples)
        .set({
          status: "error",
          checkedAt: new Date(),
          errorCode: code,
        })
        .where(
          and(
            eq(schema.publicationCommentSamples.orgId, job.orgId),
            eq(schema.publicationCommentSamples.brandId, job.brandId),
            eq(schema.publicationCommentSamples.publicationId, job.publicationId),
          ),
        );
    });
  }

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
