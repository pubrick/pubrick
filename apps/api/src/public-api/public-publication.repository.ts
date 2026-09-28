import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  decodeContentCursor,
  encodeContentCursor,
  PUBLICATION_OPERATION_FILTERS,
  type PublicPublication,
} from "@pubrick/shared";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { deliveryOutcomeSql } from "../content/delivery-outcome.sql";
import { db } from "../db";

const CURSOR_AT = sql<string>`to_char(${schema.adaptations.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Public projection is explicit and independent of the larger editor DTO. */
@Injectable()
export class PublicPublicationRepository {
  async list(
    orgId: string,
    brandId: string,
    rawFilter?: string,
    rawLimit?: string,
    rawCursor?: string,
  ) {
    const [brand] = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    if (!brand) throw new NotFoundException("Brand not found");

    const filter = rawFilter ?? "needs_attention";
    if (
      typeof filter !== "string" ||
      !(PUBLICATION_OPERATION_FILTERS as readonly string[]).includes(filter)
    ) {
      throw new BadRequestException("Invalid publication filter");
    }
    const limit = rawLimit === undefined ? 30 : Number(rawLimit);
    if (rawLimit !== undefined && (typeof rawLimit !== "string" || !/^[1-9]\d*$/.test(rawLimit))) {
      throw new BadRequestException("Invalid page limit");
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new BadRequestException("Invalid page limit");
    }
    if (rawCursor !== undefined && typeof rawCursor !== "string") {
      throw new BadRequestException("Invalid cursor");
    }
    const cursor = rawCursor === undefined ? null : decodeContentCursor(rawCursor);
    if (rawCursor !== undefined && cursor === null) {
      throw new BadRequestException("Invalid cursor");
    }
    // The receipt-derived verdict differs from stored status only on failed rows.
    // Filter before reading it so the correlated receipt lookup stays page-bounded.
    const statusFilter =
      filter === "needs_attention"
        ? inArray(schema.adaptations.status, ["manual_ready", "failed"])
        : filter === "scheduled"
          ? eq(schema.adaptations.status, "scheduled")
          : filter === "published"
            ? eq(schema.adaptations.status, "published")
            : undefined;
    const rows = await db
      .select({
        id: schema.adaptations.id,
        contentItemId: schema.adaptations.contentItemId,
        channelId: schema.adaptations.channelId,
        platform: schema.channels.platform,
        deliveryOutcome: deliveryOutcomeSql,
        failureReason: schema.adaptations.failureReason,
        scheduledAt: schema.adaptations.scheduledAt,
        publishedAt: sql<Date | null>`(
          select p.created_at from publications p
          where p.adaptation_id = adaptations.id and p.status = 'published'
          limit 1
        )`,
        externalUrl: sql<string | null>`(
          select p.external_url from publications p
          where p.adaptation_id = adaptations.id and p.status = 'published'
          limit 1
        )`,
        assertedAt: sql<Date | null>`(
          select p.asserted_at from publications p
          where p.adaptation_id = adaptations.id and p.status <> 'in_flight'
          order by p.created_at desc limit 1
        )`,
        createdAt: schema.adaptations.createdAt,
        cursorAt: CURSOR_AT,
      })
      .from(schema.adaptations)
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
          eq(schema.channels.orgId, orgId),
          eq(schema.channels.brandId, brandId),
        ),
      )
      .where(
        and(
          eq(schema.adaptations.orgId, orgId),
          statusFilter,
          cursor
            ? sql`(${schema.adaptations.createdAt}, ${schema.adaptations.id}) < (${sql.param(cursor.createdAt)}::timestamptz, ${sql.param(cursor.id)}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(schema.adaptations.createdAt), desc(schema.adaptations.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    const projected: PublicPublication[] = page.map((row) => ({
      id: row.id,
      contentItemId: row.contentItemId,
      channelId: row.channelId,
      platform: row.platform,
      deliveryOutcome: row.deliveryOutcome,
      failureReason: row.failureReason,
      scheduledAt: row.scheduledAt?.toISOString() ?? null,
      publishedAt: row.publishedAt ? new Date(row.publishedAt).toISOString() : null,
      externalUrl: row.externalUrl,
      assertedAt: row.assertedAt ? new Date(row.assertedAt).toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    }));
    return {
      rows: projected,
      nextCursor:
        rows.length > limit && last
          ? encodeContentCursor({ createdAt: last.cursorAt, id: last.id })
          : null,
    };
  }
}
