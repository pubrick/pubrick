import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  type ArchivedPublicationsPageDto,
  type ArchivedPublicationsQuery,
  decodeContentCursor,
  encodeContentCursor,
} from "@pubrick/shared";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { badRequest, notFound } from "../api-error";
import { db } from "../db";

@Injectable()
export class ArchivedPublicationsRepository {
  /** Receipts without a live channel, scoped by the immutable brand snapshot. */
  async list(
    orgId: string,
    brandId: string,
    query: ArchivedPublicationsQuery,
  ): Promise<ArchivedPublicationsPageDto> {
    const [brand] = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    if (!brand) throw notFound("brand_not_found", "Brand not found");

    const cursor = query.cursor === undefined ? null : decodeContentCursor(query.cursor);
    if (query.cursor !== undefined && cursor === null) {
      throw badRequest("invalid_request", "Malformed archived publication cursor");
    }
    const cursorAt = sql<string>`to_char(${schema.publications.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    const rows = await db
      .select({
        id: schema.publications.id,
        channelName: schema.publications.channelName,
        channelPlatform: schema.publications.channelPlatform,
        status: schema.publications.status,
        externalUrl: schema.publications.externalUrl,
        assertedAt: schema.publications.assertedAt,
        createdAt: schema.publications.createdAt,
        cursorAt,
      })
      .from(schema.publications)
      .where(
        and(
          eq(schema.publications.orgId, orgId),
          eq(schema.publications.brandId, brandId),
          isNull(schema.publications.channelId),
          cursor
            ? sql`(${schema.publications.createdAt}, ${schema.publications.id}) < (${sql.param(cursor.createdAt)}::timestamptz, ${sql.param(cursor.id)}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(schema.publications.createdAt), desc(schema.publications.id))
      .limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      rows: page.map(({ cursorAt: _cursorAt, ...row }) => ({
        ...row,
        assertedAt: row.assertedAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length > query.limit && last
          ? encodeContentCursor({ createdAt: last.cursorAt, id: last.id })
          : null,
    };
  }
}
