import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization, user } from "./auth.js";
import { contentItems } from "./content-items.js";

/** Append-only feedback about an exact saved master draft, independent of authorship evidence. */
export const editorialNotes = pgTable(
  "editorial_notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contentItemId: uuid("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    /** SHA-256 of the saved body at submission, so later edits cannot relabel this note. */
    bodyHash: text("body_hash").notNull(),
    note: text("note").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("editorial_notes_org_id_idx").on(t.orgId),
    index("editorial_notes_item_created_idx").on(
      t.orgId,
      t.contentItemId,
      t.createdAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
  ],
);
