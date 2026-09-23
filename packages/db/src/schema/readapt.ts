import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth.js";
import { adaptations, contentItems } from "./content-items.js";

/** One immutable, model-authored suggestion per channel. A new request replaces the row. */
export const adaptationProposals = pgTable(
  "adaptation_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contentItemId: uuid("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    adaptationId: uuid("adaptation_id").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    /** Both inputs are retained so Accept cannot apply a suggestion to changed text. */
    masterBody: text("master_body").notNull(),
    previousBody: text("previous_body"),
    proposal: text("proposal").notNull(),
    reason: text("reason").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("adaptation_proposals_adaptation_id_idx").on(t.adaptationId),
    foreignKey({
      name: "adaptation_proposals_adaptation_item_fk",
      columns: [t.adaptationId, t.contentItemId],
      foreignColumns: [adaptations.id, adaptations.contentItemId],
    }).onDelete("cascade"),
    check("adaptation_proposals_proposal_nonblank", sql`length(btrim(${t.proposal})) > 0`),
  ],
);
