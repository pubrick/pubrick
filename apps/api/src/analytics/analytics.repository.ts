import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { readVkPostMetrics } from "@pubrick/integrations";
import {
  type AnalyticsDto,
  isPublicTelegramPostUrl,
  type PublicationCommentsDto,
  type PublicationMetricsDto,
} from "@pubrick/shared";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { conflict, notFound } from "../api-error";
import { ChannelsRepository } from "../channels/channels.repository";
import { db } from "../db";
import { env } from "../env";
import { QueueService } from "../queue/queue.service";

const MAX_POSTS = 100;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function metricState(
  row: {
    status: "refreshing" | "available" | "unavailable" | "error";
    checkedAt: Date;
    views: number | null;
    likes: number | null;
    comments: number | null;
    shares: number | null;
  } | null,
): PublicationMetricsDto {
  return {
    status: row?.status ?? "not_collected",
    stale: row !== null && Date.now() - row.checkedAt.getTime() > STALE_AFTER_MS,
    checkedAt: row?.checkedAt.toISOString() ?? null,
    views: row?.status === "available" ? row.views : null,
    likes: row?.status === "available" ? row.likes : null,
    comments: row?.status === "available" ? row.comments : null,
    shares: row?.status === "available" ? row.shares : null,
  };
}

@Injectable()
export class AnalyticsRepository {
  constructor(
    private readonly channels: ChannelsRepository,
    private readonly queue: QueueService,
  ) {}

  private async requireBrand(orgId: string, brandId: string) {
    const found = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    if (!found[0]) throw notFound("brand_not_found", "Brand not found");
  }

  /** A receipt alone is insufficient: its channel/item links may have been erased. */
  private async liveTelegramPublication(orgId: string, brandId: string, publicationId: string) {
    await this.requireBrand(orgId, brandId);
    const [row] = await db
      .select({
        id: schema.publications.id,
        adaptationId: schema.publications.adaptationId,
        channelId: schema.publications.channelId,
        contentItemId: schema.adaptations.contentItemId,
        externalId: schema.publications.externalId,
        externalUrl: schema.publications.externalUrl,
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
    if (!row) throw notFound("publication_not_found", "Telegram publication not found");
    return row;
  }

  /** Hold the live ownership chain while admitting a queue job. */
  private async lockLiveTelegramPublication(
    tx: Tx,
    orgId: string,
    brandId: string,
    publication: Awaited<ReturnType<AnalyticsRepository["liveTelegramPublication"]>>,
  ) {
    if (
      !publication.adaptationId ||
      !publication.channelId ||
      !publication.externalId ||
      !publication.externalUrl
    ) {
      throw notFound("publication_not_found", "Telegram publication not found");
    }
    const [adaptation] = await tx
      .select({ id: schema.adaptations.id })
      .from(schema.adaptations)
      .where(
        and(
          eq(schema.adaptations.id, publication.adaptationId),
          eq(schema.adaptations.orgId, orgId),
          eq(schema.adaptations.contentItemId, publication.contentItemId),
          eq(schema.adaptations.channelId, publication.channelId),
        ),
      )
      .limit(1)
      .for("share");
    if (!adaptation) throw notFound("publication_not_found", "Telegram publication not found");
    const [channel] = await tx
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.id, publication.channelId),
          eq(schema.channels.orgId, orgId),
          eq(schema.channels.brandId, brandId),
          eq(schema.channels.platform, "telegram"),
        ),
      )
      .limit(1)
      .for("share");
    if (!channel) throw notFound("publication_not_found", "Telegram publication not found");
    const [item] = await tx
      .select({ id: schema.contentItems.id })
      .from(schema.contentItems)
      .where(
        and(
          eq(schema.contentItems.id, publication.contentItemId),
          eq(schema.contentItems.orgId, orgId),
          eq(schema.contentItems.brandId, brandId),
        ),
      )
      .limit(1)
      .for("share");
    if (!item) throw notFound("publication_not_found", "Telegram publication not found");
    const [receipt] = await tx
      .select({ id: schema.publications.id })
      .from(schema.publications)
      .where(
        and(
          eq(schema.publications.id, publication.id),
          eq(schema.publications.orgId, orgId),
          eq(schema.publications.status, "published"),
          eq(schema.publications.adaptationId, publication.adaptationId),
          eq(schema.publications.channelId, publication.channelId),
          eq(schema.publications.externalId, publication.externalId),
          eq(schema.publications.externalUrl, publication.externalUrl),
        ),
      )
      .limit(1)
      .for("share");
    if (!receipt) throw notFound("publication_not_found", "Telegram publication not found");
  }

  async comments(
    orgId: string,
    brandId: string,
    publicationId: string,
  ): Promise<PublicationCommentsDto> {
    const publication = await this.liveTelegramPublication(orgId, brandId, publicationId);
    const [sample] = await db
      .select({
        status: schema.publicationCommentSamples.status,
        checkedAt: schema.publicationCommentSamples.checkedAt,
        requestedAt: schema.publicationCommentSamples.requestedAt,
        errorCode: schema.publicationCommentSamples.errorCode,
      })
      .from(schema.publicationCommentSamples)
      .where(
        and(
          eq(schema.publicationCommentSamples.orgId, orgId),
          eq(schema.publicationCommentSamples.brandId, brandId),
          eq(schema.publicationCommentSamples.publicationId, publicationId),
        ),
      )
      .limit(1);
    const comments = await db
      .select({
        id: schema.publicationComments.id,
        body: schema.publicationComments.body,
        publishedAt: schema.publicationComments.publishedAt,
      })
      .from(schema.publicationComments)
      .where(
        and(
          eq(schema.publicationComments.orgId, orgId),
          eq(schema.publicationComments.brandId, brandId),
          eq(schema.publicationComments.publicationId, publicationId),
        ),
      )
      .orderBy(desc(schema.publicationComments.publishedAt), desc(schema.publicationComments.id))
      .limit(50);
    const publicUrl = isPublicTelegramPostUrl(publication.externalUrl, publication.externalId);
    const abandoned =
      sample?.status === "pending" && Date.now() - sample.requestedAt.getTime() >= 15 * 60 * 1000;
    return {
      status: publicUrl
        ? abandoned
          ? "error"
          : (sample?.status ?? "not_collected")
        : "unavailable",
      canCollect: publicUrl,
      checkedAt: sample?.checkedAt?.toISOString() ?? null,
      requestedAt: sample?.requestedAt.toISOString() ?? null,
      errorCode: publicUrl
        ? abandoned
          ? "telegram_collection_failed"
          : (sample?.errorCode ?? null)
        : null,
      comments: comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        publishedAt: comment.publishedAt.toISOString(),
      })),
    };
  }

  async refreshComments(orgId: string, brandId: string, publicationId: string) {
    const publication = await this.liveTelegramPublication(orgId, brandId, publicationId);
    if (!isPublicTelegramPostUrl(publication.externalUrl, publication.externalId)) {
      throw conflict(
        "publication_comments_unavailable",
        "Comments require a public Telegram post link",
      );
    }
    return db.transaction(async (tx) => {
      const [organization] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, orgId))
        .limit(1)
        .for("key share");
      if (!organization) throw notFound("brand_not_found", "Brand not found");
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
        .limit(1)
        .for("key share");
      if (!brand) throw notFound("brand_not_found", "Brand not found");
      await this.lockLiveTelegramPublication(tx, orgId, brandId, publication);
      const [claimed] = await tx
        .insert(schema.publicationCommentSamples)
        .values({ orgId, brandId, publicationId, status: "pending" })
        .onConflictDoUpdate({
          target: schema.publicationCommentSamples.publicationId,
          set: { status: "pending", requestedAt: sql`now()`, errorCode: null },
          setWhere: lt(
            schema.publicationCommentSamples.requestedAt,
            sql`now() - interval '15 minutes'`,
          ),
        })
        .returning({
          publicationId: schema.publicationCommentSamples.publicationId,
          requestedAt: schema.publicationCommentSamples.requestedAt,
        });
      if (!claimed) {
        throw conflict("publication_comments_refresh_cooldown", "This post was checked recently");
      }
      const queued = await this.queue.enqueueTelegramComments(tx, {
        kind: "publication",
        orgId,
        brandId,
        publicationId,
        requestedAt: claimed.requestedAt.toISOString(),
      });
      if (!queued) {
        throw conflict(
          "publication_comments_refresh_cooldown",
          "Comment collection is already queued",
        );
      }
      return { queued: true };
    });
  }

  async list(orgId: string, brandId: string, days: 7 | 30 | 90): Promise<AnalyticsDto> {
    await this.requireBrand(orgId, brandId);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const rows = await db
      .select({
        id: schema.publications.id,
        externalId: schema.publications.externalId,
        contentItemId: schema.contentItems.id,
        title: schema.contentItems.title,
        channelName: schema.channels.name,
        platform: schema.channels.platform,
        externalUrl: schema.publications.externalUrl,
        publishedAt: schema.publications.createdAt,
        metrics: {
          status: schema.publicationMetrics.status,
          checkedAt: schema.publicationMetrics.checkedAt,
          views: schema.publicationMetrics.views,
          likes: schema.publicationMetrics.likes,
          comments: schema.publicationMetrics.comments,
          shares: schema.publicationMetrics.shares,
        },
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
        ),
      )
      .leftJoin(
        schema.channels,
        and(
          eq(schema.channels.id, schema.publications.channelId),
          eq(schema.channels.orgId, orgId),
        ),
      )
      .leftJoin(
        schema.publicationMetrics,
        and(
          eq(schema.publicationMetrics.publicationId, schema.publications.id),
          eq(schema.publicationMetrics.orgId, orgId),
        ),
      )
      .where(
        and(
          eq(schema.publications.orgId, orgId),
          eq(schema.contentItems.brandId, brandId),
          eq(schema.publications.status, "published"),
          gte(schema.publications.createdAt, since),
        ),
      )
      .orderBy(desc(schema.publications.createdAt), desc(schema.publications.id))
      .limit(MAX_POSTS + 1);
    const posts = rows.slice(0, MAX_POSTS).map((row) => ({
      id: row.id,
      contentItemId: row.contentItemId,
      title: row.title,
      platform: row.platform ?? "unknown",
      channelName: row.channelName ?? "Removed channel",
      externalUrl: row.externalUrl,
      publishedAt: row.publishedAt.toISOString(),
      metrics: metricState(row.metrics),
      canRefresh:
        row.platform === "vk" &&
        row.externalId !== null &&
        (row.metrics === null || Date.now() - row.metrics.checkedAt.getTime() >= 15 * 60 * 1000),
    }));
    const measured = posts.filter((post) => post.metrics.status === "available");
    const sum = (key: "views" | "likes" | "comments" | "shares") => {
      const known = measured
        .map((post) => post.metrics[key])
        .filter((v): v is number => v !== null);
      return known.length ? known.reduce((a, b) => a + b, 0) : null;
    };
    return {
      days,
      publishedCount: posts.length,
      measuredCount: measured.length,
      hasMore: rows.length > MAX_POSTS,
      totals: {
        views: sum("views"),
        likes: sum("likes"),
        comments: sum("comments"),
        shares: sum("shares"),
      },
      posts,
    };
  }

  /** On-demand, one VK read per post per 15 minutes, claimed before the network call. */
  async refresh(
    orgId: string,
    brandId: string,
    publicationId: string,
  ): Promise<PublicationMetricsDto> {
    await this.requireBrand(orgId, brandId);
    const rows = await db
      .select({
        id: schema.publications.id,
        channelId: schema.publications.channelId,
        externalId: schema.publications.externalId,
        platform: schema.channels.platform,
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
        ),
      )
      .leftJoin(
        schema.channels,
        and(
          eq(schema.channels.id, schema.publications.channelId),
          eq(schema.channels.orgId, orgId),
        ),
      )
      .where(
        and(
          eq(schema.publications.id, publicationId),
          eq(schema.publications.orgId, orgId),
          eq(schema.contentItems.brandId, brandId),
          eq(schema.publications.status, "published"),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row) throw notFound("publication_not_found", "Publication not found");
    if (row.platform !== "vk" || !row.channelId || !row.externalId) {
      throw conflict(
        "metrics_unavailable",
        "Automatic metrics are unavailable for this publication",
      );
    }
    const claimed = await db
      .insert(schema.publicationMetrics)
      .values({ orgId, publicationId, status: "refreshing" })
      .onConflictDoUpdate({
        target: schema.publicationMetrics.publicationId,
        set: { status: "refreshing", checkedAt: sql`now()` },
        setWhere: lt(schema.publicationMetrics.checkedAt, sql`now() - interval '15 minutes'`),
      })
      .returning({ id: schema.publicationMetrics.publicationId });
    if (!claimed[0]) throw conflict("metrics_refresh_cooldown", "This post was checked recently");
    let counters: Awaited<ReturnType<typeof readVkPostMetrics>> = null;
    let status: "available" | "unavailable" | "error" = "unavailable";
    try {
      const credentials = await this.channels.getDecryptedCredentials(orgId, row.channelId);
      counters = await readVkPostMetrics(credentials, row.externalId, {
        baseUrl: env.VK_API_BASE_URL,
      });
      status =
        counters && Object.values(counters).some((value) => value !== null)
          ? "available"
          : "unavailable";
    } catch {
      // Provider and credential failures never become invented zeroes or leak tokens.
      status = "error";
    }
    const updated = await db
      .update(schema.publicationMetrics)
      .set({
        status,
        views: status === "available" ? (counters?.views ?? null) : null,
        likes: status === "available" ? (counters?.likes ?? null) : null,
        comments: status === "available" ? (counters?.comments ?? null) : null,
        shares: status === "available" ? (counters?.shares ?? null) : null,
      })
      .where(
        and(
          eq(schema.publicationMetrics.orgId, orgId),
          eq(schema.publicationMetrics.publicationId, publicationId),
        ),
      )
      .returning({
        status: schema.publicationMetrics.status,
        checkedAt: schema.publicationMetrics.checkedAt,
        views: schema.publicationMetrics.views,
        likes: schema.publicationMetrics.likes,
        comments: schema.publicationMetrics.comments,
        shares: schema.publicationMetrics.shares,
      });
    return metricState(updated[0] ?? null);
  }
}
