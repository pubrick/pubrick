import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { readVkPostMetrics } from "@pubrick/integrations";
import type { AnalyticsDto, PublicationMetricsDto } from "@pubrick/shared";
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import { conflict, notFound } from "../api-error";
import { ChannelsRepository } from "../channels/channels.repository";
import { db } from "../db";
import { env } from "../env";

const MAX_POSTS = 100;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

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
  constructor(private readonly channels: ChannelsRepository) {}

  private async requireBrand(orgId: string, brandId: string) {
    const found = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    if (!found[0]) throw notFound("brand_not_found", "Brand not found");
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
