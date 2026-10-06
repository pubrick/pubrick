import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { type BillingTransaction, schema } from "@pubrick/db";
import {
  type ContentCursor,
  decodeContentCursor,
  encodeContentCursor,
  PUBLICATION_RESULTS_EXPORT_LIMIT,
  type PublicationResultRow,
  type PublicationResultsPage,
  type PublicationResultsQuery,
  type PublicationResultsSummary,
  RESULT_COUNTERS,
} from "@pubrick/shared";
import { stringify } from "csv-stringify/sync";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { badRequest, notFound } from "../api-error";
import { db } from "../db";

const cursorSchema = z.strictObject({
  version: z.literal(1),
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  position: z.string().max(256),
});
type Aggregate = {
  publishedCount: string;
  assertedCount: string;
  measuredCount: string;
  staleCount: string;
  views: string | null;
  likes: string | null;
  comments: string | null;
  shares: string | null;
  viewsCount: string;
  likesCount: string;
  commentsCount: string;
  sharesCount: string;
};

function scope(orgId: string, brandId: string, query: PublicationResultsQuery) {
  return createHash("sha256")
    .update(JSON.stringify([orgId, brandId, query.from, query.to, query.channelId ?? null]))
    .digest("hex");
}

function readCursor(orgId: string, brandId: string, query: PublicationResultsQuery) {
  if (!query.cursor) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(query.cursor)) throw new Error("Invalid encoding");
    const parsed = cursorSchema.parse(
      JSON.parse(Buffer.from(query.cursor, "base64url").toString()),
    );
    const position = decodeContentCursor(parsed.position);
    if (
      parsed.scope !== scope(orgId, brandId, query) ||
      !position ||
      !z.iso.datetime().safeParse(position.createdAt).success ||
      Date.parse(position.createdAt) < Date.parse("0001-01-01T00:00:00.000Z")
    )
      throw new Error("Changed scope");
    return position;
  } catch {
    throw badRequest("invalid_request", "Reload publication results after changing the filters");
  }
}

function writeCursor(
  orgId: string,
  brandId: string,
  query: PublicationResultsQuery,
  position: ContentCursor,
) {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      scope: scope(orgId, brandId, query),
      position: encodeContentCursor(position),
    }),
  ).toString("base64url");
}

/** Archived receipts have an immutable brand snapshot; live channels remain authoritative. */
function joins(orgId: string) {
  return sql`from publications p
    left join channels c on c.org_id = ${orgId} and c.id = p.channel_id
    left join publication_metrics m on m.org_id = ${orgId} and m.publication_id = p.id`;
}
function cohort(orgId: string, brandId: string, query: PublicationResultsQuery) {
  return sql`p.org_id = ${orgId} and p.status = 'published'
    and ((c.id is not null and c.brand_id = ${brandId}::uuid)
      or (p.channel_id is null and p.brand_id = ${brandId}::uuid))
    and p.created_at >= ${query.from}::timestamptz and p.created_at < ${query.to}::timestamptz
    ${query.channelId ? sql`and c.id = ${query.channelId}::uuid` : sql``}`;
}
function aggregateColumns(now: Date) {
  return sql`count(*)::text as "publishedCount",
    count(p.asserted_at)::text as "assertedCount",
    count(*) filter (where m.status = 'available')::text as "measuredCount",
    count(*) filter (where m.status = 'available' and m.checked_at < ${new Date(now.getTime() - 86_400_000)})::text as "staleCount",
    sum(case when m.status = 'available' then m.views end)::text as views,
    sum(case when m.status = 'available' then m.likes end)::text as likes,
    sum(case when m.status = 'available' then m.comments end)::text as comments,
    sum(case when m.status = 'available' then m.shares end)::text as shares,
    count(m.views) filter (where m.status = 'available')::text as "viewsCount",
    count(m.likes) filter (where m.status = 'available')::text as "likesCount",
    count(m.comments) filter (where m.status = 'available')::text as "commentsCount",
    count(m.shares) filter (where m.status = 'available')::text as "sharesCount"`;
}
function summary(row: Aggregate): PublicationResultsSummary {
  return {
    publishedCount: Number(row.publishedCount),
    assertedCount: Number(row.assertedCount),
    measuredCount: Number(row.measuredCount),
    staleCount: Number(row.staleCount),
    totals: {
      views: row.views === null ? null : Number(row.views),
      likes: row.likes === null ? null : Number(row.likes),
      comments: row.comments === null ? null : Number(row.comments),
      shares: row.shares === null ? null : Number(row.shares),
    },
    observedCounts: {
      views: Number(row.viewsCount),
      likes: Number(row.likesCount),
      comments: Number(row.commentsCount),
      shares: Number(row.sharesCount),
    },
  };
}

async function postRows(
  tx: BillingTransaction,
  orgId: string,
  brandId: string,
  query: PublicationResultsQuery,
  limit: number,
  cursor: ContentCursor | null,
) {
  const p = schema.publications;
  const c = schema.channels;
  const m = schema.publicationMetrics;
  return tx
    .select({
      id: p.id,
      contentItemId: schema.contentItems.id,
      title: schema.contentItems.title,
      channelId: c.id,
      channelName: sql<string>`coalesce(${c.name}, ${p.channelName}, 'Removed channel')`,
      platform: sql<string>`coalesce(${c.platform}, ${p.channelPlatform}, 'unknown')`,
      externalId: p.externalId,
      externalUrl: p.externalUrl,
      assertedAt: p.assertedAt,
      recordedAt: p.createdAt,
      cursorAt: sql<string>`to_char(${p.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      metrics: {
        status: m.status,
        checkedAt: m.checkedAt,
        views: m.views,
        likes: m.likes,
        comments: m.comments,
        shares: m.shares,
      },
    })
    .from(p)
    .leftJoin(c, and(eq(c.orgId, orgId), eq(c.id, p.channelId)))
    .leftJoin(
      schema.adaptations,
      and(
        eq(schema.adaptations.orgId, orgId),
        eq(schema.adaptations.id, p.adaptationId),
        eq(schema.adaptations.channelId, p.channelId),
      ),
    )
    .leftJoin(
      schema.contentItems,
      and(
        eq(schema.contentItems.orgId, orgId),
        eq(schema.contentItems.id, schema.adaptations.contentItemId),
        eq(schema.contentItems.brandId, brandId),
      ),
    )
    .leftJoin(m, and(eq(m.orgId, orgId), eq(m.publicationId, p.id)))
    .where(
      and(
        eq(p.orgId, orgId),
        eq(p.status, "published"),
        sql`((${c.id} is not null and ${c.brandId} = ${brandId}::uuid) or (${p.channelId} is null and ${p.brandId} = ${brandId}::uuid))`,
        sql`${p.createdAt} >= ${query.from}::timestamptz and ${p.createdAt} < ${query.to}::timestamptz`,
        query.channelId ? eq(c.id, query.channelId) : undefined,
        cursor
          ? sql`(${p.createdAt}, ${p.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
          : undefined,
      ),
    )
    .orderBy(desc(p.createdAt), desc(p.id))
    .limit(limit);
}
function post(row: Awaited<ReturnType<typeof postRows>>[number], now: Date): PublicationResultRow {
  const available = row.metrics?.status === "available";
  return {
    id: row.id,
    contentItemId: row.contentItemId,
    title: row.title,
    channelId: row.channelId,
    channelName: row.channelName,
    platform: row.platform,
    archived: row.channelId === null,
    assertedAt: row.assertedAt?.toISOString() ?? null,
    externalUrl: row.externalUrl,
    recordedAt: row.recordedAt.toISOString(),
    metrics: {
      status: row.metrics?.status ?? "not_collected",
      stale: row.metrics !== null && now.getTime() - row.metrics.checkedAt.getTime() > 86_400_000,
      checkedAt: row.metrics?.checkedAt.toISOString() ?? null,
      views: available ? (row.metrics?.views ?? null) : null,
      likes: available ? (row.metrics?.likes ?? null) : null,
      comments: available ? (row.metrics?.comments ?? null) : null,
      shares: available ? (row.metrics?.shares ?? null) : null,
    },
    canRefresh:
      row.channelId !== null &&
      row.platform === "vk" &&
      row.externalId !== null &&
      (row.metrics === null || now.getTime() - row.metrics.checkedAt.getTime() >= 15 * 60_000),
  };
}

@Injectable()
export class PublicationResultsRepository {
  private async requireScope(
    tx: BillingTransaction,
    orgId: string,
    brandId: string,
    query: PublicationResultsQuery,
  ) {
    const [brand] = await tx
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)));
    if (!brand) throw notFound("brand_not_found", "Brand not found");
    if (query.channelId) {
      const [channel] = await tx
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(
          and(
            eq(schema.channels.orgId, orgId),
            eq(schema.channels.brandId, brandId),
            eq(schema.channels.id, query.channelId),
          ),
        );
      if (!channel) throw notFound("channel_not_found", "Channel not found");
    }
  }
  /** Each response has one database snapshot; totals cover the whole cohort, before paging. */
  async list(
    orgId: string,
    brandId: string,
    query: PublicationResultsQuery,
  ): Promise<PublicationResultsPage> {
    const cursor = readCursor(orgId, brandId, query);
    return db.transaction(
      async (tx) => {
        await this.requireScope(tx, orgId, brandId, query);
        const clock = await tx.execute<{ nowMs: string }>(
          sql`select (extract(epoch from transaction_timestamp()) * 1000)::text as "nowMs"`,
        );
        if (!clock.rows[0]) throw new Error("Missing database clock");
        const now = new Date(Number(clock.rows[0].nowMs));
        const span = Date.parse(query.to) - Date.parse(query.from);
        const previousQuery = {
          ...query,
          from: new Date(Date.parse(query.from) - span).toISOString(),
          to: query.from,
        };
        const current = await tx.execute<Aggregate>(
          sql`select ${aggregateColumns(now)} ${joins(orgId)} where ${cohort(orgId, brandId, query)}`,
        );
        const previous = await tx.execute<Aggregate>(
          sql`select ${aggregateColumns(now)} ${joins(orgId)} where ${cohort(orgId, brandId, previousQuery)}`,
        );
        const channelRows = await tx.execute<
          Aggregate & { id: string | null; name: string; platform: string }
        >(sql`
        select c.id, coalesce(c.name, p.channel_name, 'Removed channel') as name,
          coalesce(c.platform, p.channel_platform, 'unknown') as platform, ${aggregateColumns(now)}
        ${joins(orgId)} where ${cohort(orgId, brandId, query)}
        group by c.id, coalesce(c.name, p.channel_name, 'Removed channel'), coalesce(c.platform, p.channel_platform, 'unknown')
        order by name, platform, c.id nulls last`);
        const rows = await postRows(tx, orgId, brandId, query, query.limit + 1, cursor);
        const page = rows.slice(0, query.limit);
        const last = page.at(-1);
        const currentSummary = current.rows[0];
        const previousSummary = previous.rows[0];
        if (!currentSummary || !previousSummary) throw new Error("Missing publication aggregate");
        return {
          from: query.from,
          to: query.to,
          summary: summary(currentSummary),
          previous: {
            from: previousQuery.from,
            to: previousQuery.to,
            summary: summary(previousSummary),
          },
          channels: channelRows.rows.map((row) => ({
            id: row.id,
            name: row.name,
            platform: row.platform,
            archived: row.id === null,
            canCollectMetrics: row.id !== null && row.platform === "vk",
            summary: summary(row),
          })),
          rows: page.map((row) => post(row, now)),
          nextCursor:
            rows.length > query.limit && last
              ? writeCursor(orgId, brandId, query, { createdAt: last.cursorAt, id: last.id })
              : null,
        };
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }

  /** Maintained serializer owns CSV quoting and formula escaping; oversized exports refuse whole. */
  async export(orgId: string, brandId: string, query: PublicationResultsQuery): Promise<string> {
    if (query.cursor)
      throw badRequest(
        "invalid_request",
        "An export covers the complete filtered period, not a page",
      );
    return db.transaction(
      async (tx) => {
        await this.requireScope(tx, orgId, brandId, query);
        const rows = await postRows(
          tx,
          orgId,
          brandId,
          query,
          PUBLICATION_RESULTS_EXPORT_LIMIT + 1,
          null,
        );
        if (rows.length > PUBLICATION_RESULTS_EXPORT_LIMIT)
          throw badRequest(
            "invalid_request",
            "Narrow the period or channel to export at most 10000 publications",
          );
        const now = new Date();
        return stringify(
          rows.map((row) => {
            const value = post(row, now);
            return {
              publication_id: value.id,
              recorded_at: value.recordedAt,
              title: value.title ?? "",
              channel: value.channelName,
              platform: value.platform,
              archived: value.archived,
              asserted_at: value.assertedAt ?? "",
              external_url: value.externalUrl ?? "",
              metrics_status: value.metrics.status,
              checked_at: value.metrics.checkedAt ?? "",
              stale: value.metrics.stale,
              ...Object.fromEntries(RESULT_COUNTERS.map((key) => [key, value.metrics[key] ?? ""])),
            };
          }),
          {
            header: true,
            columns: [
              "publication_id",
              "recorded_at",
              "title",
              "channel",
              "platform",
              "archived",
              "asserted_at",
              "external_url",
              "metrics_status",
              "checked_at",
              "stale",
              ...RESULT_COUNTERS,
            ],
            bom: true,
            escape_formulas: true,
            cast: { boolean: (value) => String(value) },
          },
        );
      },
      { isolationLevel: "repeatable read", accessMode: "read only" },
    );
  }
}
