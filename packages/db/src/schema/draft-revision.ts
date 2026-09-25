import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organization, user } from "./auth.js";
import { contentItems } from "./content-items.js";

/** One pending model rewrite of an exact saved master body. */
export const draftRevisionProposals = pgTable(
  "draft_revision_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contentItemId: uuid("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    sourceBody: text("source_body").notNull(),
    sourceTitle: text("source_title"),
    instruction: text("instruction").notNull(),
    proposal: text("proposal").notNull(),
    proposedTitle: text("proposed_title"),
    imagePlan: jsonb("image_plan"),
    reason: text("reason").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("draft_revision_proposals_org_id_idx").on(t.orgId),
    uniqueIndex("draft_revision_proposals_item_id_idx").on(t.contentItemId),
  ],
);
