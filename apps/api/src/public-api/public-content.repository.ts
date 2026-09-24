import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  CONTENT_PAGE_SIZE,
  CONTENT_STATUSES,
  decodeContentCursor,
  encodeContentCursor,
  MAX_CONTENT_PAGE_SIZE,
} from "@pubrick/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";

/** Public wire projections. Never spread a row from the internal editor DTO. */
const LIST_COLUMNS = {
  id: schema.contentItems.id,
  brandId: schema.contentItems.brandId,
  title: schema.contentItems.title,
  status: schema.contentItems.status,
  origin: schema.contentItems.origin,
  createdAt: schema.contentItems.createdAt,
  updatedAt: schema.contentItems.updatedAt,
};

const DETAIL_COLUMNS = { ...LIST_COLUMNS, body: schema.contentItems.body };
const CURSOR_AT = sql<string>`to_char(${schema.contentItems.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

@Injectable()
export class PublicContentRepository {
  async list(orgId: string, status?: string, rawLimit?: string, rawCursor?: string) {
    if (status !== undefined && !(CONTENT_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException("Invalid content status");
    }
    const limit = rawLimit === undefined ? CONTENT_PAGE_SIZE : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONTENT_PAGE_SIZE) {
      throw new BadRequestException("Invalid page limit");
    }
    const cursor = rawCursor === undefined ? null : decodeContentCursor(rawCursor);
    if (rawCursor !== undefined && cursor === null) {
      throw new BadRequestException("Invalid cursor");
    }
    const rows = await db
      .select({ ...LIST_COLUMNS, cursorAt: CURSOR_AT })
      .from(schema.contentItems)
      .where(
        and(
          eq(schema.contentItems.orgId, orgId),
          status
            ? eq(schema.contentItems.status, status as (typeof CONTENT_STATUSES)[number])
            : undefined,
          cursor
            ? sql`(${schema.contentItems.createdAt}, ${schema.contentItems.id}) < (${sql.param(cursor.createdAt)}::timestamptz, ${sql.param(cursor.id)}::uuid)`
            : undefined,
        ),
      )
      .orderBy(desc(schema.contentItems.createdAt), desc(schema.contentItems.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      rows: page.map(({ cursorAt: _cursorAt, ...item }) => item),
      nextCursor:
        rows.length > limit && last
          ? encodeContentCursor({ createdAt: last.cursorAt, id: last.id })
          : null,
    };
  }

  async get(orgId: string, id: string) {
    const [item] = await db
      .select(DETAIL_COLUMNS)
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .limit(1);
    if (!item) throw new NotFoundException("Content item not found");
    return item;
  }
}
