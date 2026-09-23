import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { readVkPostMetrics } from "@pubrick/integrations";
import {
  decryptJson,
  VK_METRICS_QUEUE,
  type VkMetricsJob,
  vkMetricsJobOptions,
} from "@pubrick/shared";
import { and, asc, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { db } from "../db";
import { env } from "../env";

const PAGE_SIZE = 100;
const MAX_PAGES_PER_SCAN = 5;
const oldestObservation = sql`extract(epoch from coalesce(${schema.publicationMetrics.checkedAt}, 'epoch'::timestamptz))`;

@Injectable()
export class MetricsService {
  /** At most 500 candidates per hourly tick; each job is deduplicated for an hour. */
  async scan(boss: PgBoss): Promise<number> {
    let afterId: string | null = null;
    let afterObservation: string | null = null;
    let queued = 0;
    for (let page = 0; page < MAX_PAGES_PER_SCAN; page++) {
      const rows: Array<{
        orgId: string;
        brandId: string;
        channelId: string;
        publicationId: string;
        observation: string;
      }> = await db
        .select({
          orgId: schema.channels.orgId,
          brandId: schema.channels.brandId,
          channelId: schema.channels.id,
          publicationId: schema.publications.id,
          observation: sql<string>`${oldestObservation}::text`,
        })
        .from(schema.publications)
        .innerJoin(
          schema.channels,
          and(
            eq(schema.channels.id, schema.publications.channelId),
            eq(schema.channels.orgId, schema.publications.orgId),
          ),
        )
        .innerJoin(
          schema.adaptations,
          and(
            eq(schema.adaptations.id, schema.publications.adaptationId),
            eq(schema.adaptations.orgId, schema.publications.orgId),
            eq(schema.adaptations.channelId, schema.channels.id),
          ),
        )
        .innerJoin(
          schema.contentItems,
          and(
            eq(schema.contentItems.id, schema.adaptations.contentItemId),
            eq(schema.contentItems.orgId, schema.channels.orgId),
            eq(schema.contentItems.brandId, schema.channels.brandId),
          ),
        )
        .leftJoin(
          schema.publicationMetrics,
          and(
            eq(schema.publicationMetrics.publicationId, schema.publications.id),
            eq(schema.publicationMetrics.orgId, schema.channels.orgId),
          ),
        )
        .where(
          and(
            eq(schema.channels.platform, "vk"),
            eq(schema.channels.metricsAutoRefresh, true),
            eq(schema.publications.status, "published"),
            isNotNull(schema.publications.externalId),
            gt(schema.publications.createdAt, sql`now() - interval '90 days'`),
            afterId && afterObservation
              ? sql`(${oldestObservation}, ${schema.publications.id}) > (${afterObservation}::numeric, ${afterId}::uuid)`
              : undefined,
            or(
              isNull(schema.publicationMetrics.publicationId),
              and(
                eq(schema.publicationMetrics.status, "available"),
                lt(schema.publicationMetrics.checkedAt, sql`now() - interval '24 hours'`),
              ),
              and(
                sql`${schema.publicationMetrics.status} <> 'available'`,
                lt(schema.publicationMetrics.checkedAt, sql`now() - interval '1 hour'`),
              ),
            ),
          ),
        )
        .orderBy(asc(oldestObservation), asc(schema.publications.id))
        .limit(PAGE_SIZE);
      for (const row of rows) {
        const payload: VkMetricsJob = {
          orgId: row.orgId,
          brandId: row.brandId,
          channelId: row.channelId,
          publicationId: row.publicationId,
        };
        await boss.send(
          VK_METRICS_QUEUE,
          payload,
          vkMetricsJobOptions(row.publicationId, row.channelId),
        );
        queued++;
      }
      if (rows.length < PAGE_SIZE) break;
      afterId = rows[rows.length - 1]?.publicationId ?? null;
      afterObservation = rows[rows.length - 1]?.observation ?? null;
    }
    return queued;
  }

  /** Revalidate opt-in and tenant relations immediately before the shared atomic claim. */
  async handle(job: VkMetricsJob): Promise<void> {
    const rows = await db
      .select({
        externalId: schema.publications.externalId,
        credentialsEncrypted: schema.channels.credentialsEncrypted,
      })
      .from(schema.publications)
      .innerJoin(
        schema.channels,
        and(
          eq(schema.channels.id, schema.publications.channelId),
          eq(schema.channels.id, job.channelId),
          eq(schema.channels.orgId, job.orgId),
          eq(schema.channels.brandId, job.brandId),
        ),
      )
      .innerJoin(
        schema.adaptations,
        and(
          eq(schema.adaptations.id, schema.publications.adaptationId),
          eq(schema.adaptations.orgId, job.orgId),
          eq(schema.adaptations.channelId, job.channelId),
        ),
      )
      .innerJoin(
        schema.contentItems,
        and(
          eq(schema.contentItems.id, schema.adaptations.contentItemId),
          eq(schema.contentItems.orgId, job.orgId),
          eq(schema.contentItems.brandId, job.brandId),
        ),
      )
      .where(
        and(
          eq(schema.publications.id, job.publicationId),
          eq(schema.publications.orgId, job.orgId),
          eq(schema.publications.status, "published"),
          eq(schema.channels.platform, "vk"),
          eq(schema.channels.metricsAutoRefresh, true),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (!row?.externalId) return;

    // This is the same conditional upsert as the manual API path. Postgres
    // serializes conflicting inserts/updates, so one process alone calls VK.
    const claimed = await db
      .insert(schema.publicationMetrics)
      .values({ orgId: job.orgId, publicationId: job.publicationId, status: "refreshing" })
      .onConflictDoUpdate({
        target: schema.publicationMetrics.publicationId,
        set: { status: "refreshing", checkedAt: sql`now()` },
        setWhere: lt(schema.publicationMetrics.checkedAt, sql`now() - interval '15 minutes'`),
      })
      .returning({ id: schema.publicationMetrics.publicationId });
    if (!claimed[0]) return;

    let counters: Awaited<ReturnType<typeof readVkPostMetrics>> = null;
    let status: "available" | "unavailable" | "error" = "unavailable";
    try {
      if (!row.credentialsEncrypted) throw new Error("Missing channel credentials");
      const credentials = decryptJson<Record<string, string>>(
        row.credentialsEncrypted,
        env.APP_ENCRYPTION_KEY,
      );
      counters = await readVkPostMetrics(credentials, row.externalId, {
        baseUrl: env.VK_API_BASE_URL,
      });
      status =
        counters && Object.values(counters).some((value) => value !== null)
          ? "available"
          : "unavailable";
    } catch {
      // A provider/credential failure is an observation, not a fabricated zero.
      status = "error";
    }
    await db
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
          eq(schema.publicationMetrics.orgId, job.orgId),
          eq(schema.publicationMetrics.publicationId, job.publicationId),
        ),
      );
  }
}
