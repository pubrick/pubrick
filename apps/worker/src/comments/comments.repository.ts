import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  isPublicTelegramPostUrl,
  TELEGRAM_COMMENTS_QUEUE,
  type TelegramCommentsJob,
  telegramCommentsJobOptions,
} from "@pubrick/shared";
import type { ChannelComments } from "@pubrick/telegram";
import { and, asc, eq, gte, isNull, lte, or, sql } from "drizzle-orm";
import { fromDrizzle, type PgBoss } from "pg-boss";
import { db } from "../db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type AutoJob = Extract<TelegramCommentsJob, { kind: "news_auto" }>;
const MAX_BRANDS_PER_SCAN = 10;
const MAX_ITEMS_PER_BRAND = 50;
const publicStoryUrl = /^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}\/[1-9]\d*$/;

@Injectable()
export class CommentsRepository {
  /** A fair page capped at 500 jobs per scan. All sends share the scan transaction. */
  async scanAuto(boss: PgBoss): Promise<number> {
    return db.transaction(async (tx) => {
      const lock = await tx.execute<{ acquired: boolean }>(
        sql`select pg_try_advisory_xact_lock(hashtext('news-comment-auto-scan')) as acquired`,
      );
      if (!lock.rows[0]?.acquired) return 0;
      const configs = await tx
        .select({
          orgId: schema.newsCommentCollectionConfigs.orgId,
          brandId: schema.newsCommentCollectionConfigs.brandId,
          revision: schema.newsCommentCollectionConfigs.revision,
        })
        .from(schema.newsCommentCollectionConfigs)
        .innerJoin(
          schema.telegramSourceAccounts,
          eq(schema.telegramSourceAccounts.orgId, schema.newsCommentCollectionConfigs.orgId),
        )
        .where(
          and(
            eq(schema.newsCommentCollectionConfigs.enabled, true),
            or(
              isNull(schema.newsCommentCollectionConfigs.lastScannedAt),
              lte(
                schema.newsCommentCollectionConfigs.lastScannedAt,
                sql`now() - interval '1 hour'`,
              ),
            ),
          ),
        )
        .orderBy(
          sql`${schema.newsCommentCollectionConfigs.lastScannedAt} ASC NULLS FIRST`,
          asc(schema.newsCommentCollectionConfigs.brandId),
        )
        .limit(MAX_BRANDS_PER_SCAN)
        .for("update", { of: schema.newsCommentCollectionConfigs, skipLocked: true });
      let queued = 0;
      for (const config of configs) {
        const items = await tx
          .select({ id: schema.newsItems.id, url: schema.newsItems.url })
          .from(schema.newsItems)
          .innerJoin(
            schema.newsSources,
            and(
              eq(schema.newsSources.id, schema.newsItems.sourceId),
              eq(schema.newsSources.orgId, config.orgId),
              eq(schema.newsSources.brandId, config.brandId),
            ),
          )
          .where(
            and(
              eq(schema.newsItems.orgId, config.orgId),
              eq(schema.newsItems.brandId, config.brandId),
              eq(schema.newsSources.kind, "telegram"),
              eq(schema.newsSources.isActive, true),
              eq(schema.newsItems.relevanceStatus, "scored"),
              gte(schema.newsItems.relevanceScore, 0.7),
              lte(schema.newsItems.publishedAt, sql`now() - interval '6 hours'`),
              isNull(schema.newsItems.commentsCheckedAt),
              isNull(schema.newsItems.commentsStatus),
              sql`${schema.newsItems.url} ~ '^https://t\\.me/[A-Za-z0-9_]{5,32}/[1-9][0-9]*$'`,
            ),
          )
          .orderBy(asc(schema.newsItems.publishedAt), asc(schema.newsItems.id))
          .limit(MAX_ITEMS_PER_BRAND);
        for (const item of items) {
          const sent = await boss.send(
            TELEGRAM_COMMENTS_QUEUE,
            {
              kind: "news_auto",
              orgId: config.orgId,
              brandId: config.brandId,
              itemId: item.id,
              revision: config.revision,
            } satisfies AutoJob,
            {
              ...telegramCommentsJobOptions(item.id, config.orgId),
              db: fromDrizzle(tx, sql),
            },
          );
          if (sent) queued++;
        }
        await tx
          .update(schema.newsCommentCollectionConfigs)
          .set({ lastScannedAt: new Date() })
          .where(
            and(
              eq(schema.newsCommentCollectionConfigs.orgId, config.orgId),
              eq(schema.newsCommentCollectionConfigs.brandId, config.brandId),
            ),
          );
      }
      return queued;
    });
  }

  async eligibleAuto(job: AutoJob): Promise<{ url: string } | null> {
    const [row] = await db
      .select({ url: schema.newsItems.url })
      .from(schema.newsItems)
      .innerJoin(
        schema.newsSources,
        and(
          eq(schema.newsSources.id, schema.newsItems.sourceId),
          eq(schema.newsSources.orgId, job.orgId),
          eq(schema.newsSources.brandId, job.brandId),
        ),
      )
      .innerJoin(
        schema.newsCommentCollectionConfigs,
        and(
          eq(schema.newsCommentCollectionConfigs.orgId, job.orgId),
          eq(schema.newsCommentCollectionConfigs.brandId, job.brandId),
        ),
      )
      .where(
        and(
          eq(schema.newsItems.orgId, job.orgId),
          eq(schema.newsItems.brandId, job.brandId),
          eq(schema.newsItems.id, job.itemId),
          eq(schema.newsCommentCollectionConfigs.enabled, true),
          eq(schema.newsCommentCollectionConfigs.revision, job.revision),
          eq(schema.newsSources.kind, "telegram"),
          eq(schema.newsSources.isActive, true),
          eq(schema.newsItems.relevanceStatus, "scored"),
          gte(schema.newsItems.relevanceScore, 0.7),
          lte(schema.newsItems.publishedAt, sql`now() - interval '6 hours'`),
          isNull(schema.newsItems.commentsCheckedAt),
          isNull(schema.newsItems.commentsStatus),
        ),
      )
      .limit(1);
    return row && publicStoryUrl.test(row.url) ? row : null;
  }

  /** Config lock serializes the final write with an owner's opt-out/update. */
  private async lockAuto(tx: Tx, job: AutoJob, url: string) {
    const [config] = await tx
      .select({ revision: schema.newsCommentCollectionConfigs.revision })
      .from(schema.newsCommentCollectionConfigs)
      .where(
        and(
          eq(schema.newsCommentCollectionConfigs.orgId, job.orgId),
          eq(schema.newsCommentCollectionConfigs.brandId, job.brandId),
          eq(schema.newsCommentCollectionConfigs.enabled, true),
          eq(schema.newsCommentCollectionConfigs.revision, job.revision),
        ),
      )
      .limit(1)
      .for("share");
    if (!config) return null;
    const [source] = await tx
      .select({ id: schema.newsSources.id })
      .from(schema.newsItems)
      .innerJoin(
        schema.newsSources,
        and(
          eq(schema.newsSources.id, schema.newsItems.sourceId),
          eq(schema.newsSources.orgId, job.orgId),
          eq(schema.newsSources.brandId, job.brandId),
        ),
      )
      .where(
        and(
          eq(schema.newsItems.id, job.itemId),
          eq(schema.newsItems.orgId, job.orgId),
          eq(schema.newsItems.brandId, job.brandId),
          eq(schema.newsSources.kind, "telegram"),
          eq(schema.newsSources.isActive, true),
        ),
      )
      .limit(1)
      .for("share", { of: schema.newsSources });
    if (!source) return null;
    const [item] = await tx
      .select({ id: schema.newsItems.id })
      .from(schema.newsItems)
      .where(
        and(
          eq(schema.newsItems.id, job.itemId),
          eq(schema.newsItems.orgId, job.orgId),
          eq(schema.newsItems.brandId, job.brandId),
          eq(schema.newsItems.url, url),
          eq(schema.newsItems.relevanceStatus, "scored"),
          gte(schema.newsItems.relevanceScore, 0.7),
          lte(schema.newsItems.publishedAt, sql`now() - interval '6 hours'`),
          isNull(schema.newsItems.commentsCheckedAt),
          isNull(schema.newsItems.commentsStatus),
        ),
      )
      .limit(1)
      .for("update");
    return item && publicStoryUrl.test(url) ? item : null;
  }

  async saveAuto(job: AutoJob, url: string, result: ChannelComments): Promise<void> {
    await db.transaction(async (tx) => {
      if (!(await this.lockAuto(tx, job, url))) return;
      const comments = result.comments.slice(0, 50);
      if (comments.length)
        await tx.insert(schema.newsComments).values(
          comments.map((comment) => ({
            orgId: job.orgId,
            brandId: job.brandId,
            itemId: job.itemId,
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
        .where(and(eq(schema.newsItems.orgId, job.orgId), eq(schema.newsItems.id, job.itemId)));
    });
  }

  async failAuto(job: AutoJob, url: string, code: string): Promise<void> {
    await db.transaction(async (tx) => {
      if (!(await this.lockAuto(tx, job, url))) return;
      await tx
        .update(schema.newsItems)
        .set({ commentsStatus: "error", commentsCheckedAt: new Date(), commentsErrorCode: code })
        .where(and(eq(schema.newsItems.orgId, job.orgId), eq(schema.newsItems.id, job.itemId)));
    });
  }
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
