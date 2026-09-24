import { createHash } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import type { EditorialNoteCreate } from "@pubrick/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { conflict, notFound } from "../api-error";
import { db } from "../db";

const noteColumns = {
  id: schema.editorialNotes.id,
  note: schema.editorialNotes.note,
  bodyHash: schema.editorialNotes.bodyHash,
  createdBy: schema.editorialNotes.createdBy,
  createdAt: schema.editorialNotes.createdAt,
};

function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

@Injectable()
export class EditorialNotesRepository {
  async create(orgId: string, itemId: string, createdBy: string, input: EditorialNoteCreate) {
    return db.transaction(async (tx) => {
      // The item lock serializes this snapshot with edits to the same body.
      const [item] = await tx
        .select({ body: schema.contentItems.body })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, itemId)))
        .for("update")
        .limit(1);
      if (!item) throw notFound("content_not_found", "Content item not found");
      if (item.body !== input.expectedBody) {
        throw conflict("editorial_note_stale", "This post changed; reload before adding a note");
      }
      const [row] = await tx
        .insert(schema.editorialNotes)
        .values({
          orgId,
          contentItemId: itemId,
          createdBy,
          bodyHash: hashBody(item.body),
          note: input.note,
        })
        .returning(noteColumns);
      if (!row) throw new Error("Editorial note insert returned no row");
      const [author] = await tx
        .select({ name: schema.user.name })
        .from(schema.user)
        .where(eq(schema.user.id, createdBy))
        .limit(1);
      return {
        id: row.id,
        note: row.note,
        current: true,
        createdBy: row.createdBy,
        authorName: author?.name ?? null,
        createdAt: row.createdAt,
      };
    });
  }

  async list(orgId: string, itemId: string, cursor?: string) {
    const [item] = await db
      .select({ body: schema.contentItems.body })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, itemId)))
      .limit(1);
    if (!item) throw notFound("content_not_found", "Content item not found");
    const [before] = cursor
      ? await db
          .select({ id: schema.editorialNotes.id })
          .from(schema.editorialNotes)
          .where(
            and(
              eq(schema.editorialNotes.orgId, orgId),
              eq(schema.editorialNotes.contentItemId, itemId),
              eq(schema.editorialNotes.id, cursor),
            ),
          )
          .limit(1)
      : [undefined];
    if (cursor && !before) throw notFound("content_not_found", "Note cursor not found");
    const page = await db
      .select({ ...noteColumns, authorName: schema.user.name })
      .from(schema.editorialNotes)
      .leftJoin(schema.user, eq(schema.editorialNotes.createdBy, schema.user.id))
      .where(
        and(
          eq(schema.editorialNotes.orgId, orgId),
          eq(schema.editorialNotes.contentItemId, itemId),
          before
            ? sql<boolean>`(${schema.editorialNotes.createdAt}, ${schema.editorialNotes.id}) < (
                SELECT cursor_note.created_at, cursor_note.id
                FROM editorial_notes AS cursor_note
                WHERE cursor_note.id = ${before.id}
                  AND cursor_note.org_id = ${orgId}
                  AND cursor_note.content_item_id = ${itemId}
              )`
            : undefined,
        ),
      )
      .orderBy(desc(schema.editorialNotes.createdAt), desc(schema.editorialNotes.id))
      .limit(21);
    const currentHash = hashBody(item.body);
    return {
      rows: page.slice(0, 20).map((row) => ({
        id: row.id,
        note: row.note,
        current: row.bodyHash === currentHash,
        createdBy: row.createdBy,
        authorName: row.authorName,
        createdAt: row.createdAt,
      })),
      nextCursor: page.length > 20 ? (page[19]?.id ?? null) : null,
    };
  }
}
