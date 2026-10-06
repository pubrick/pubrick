import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { contentItems } from "./content-items.js";

/**
 * Membership identities are retained audit values, not foreign keys. Removal
 * must leave a recoverable unavailable assignment; rejoining with another
 * membership must not silently revive it. Eligibility is checked against live
 * tenant membership and brand grants on reads and writes.
 */
export const contentAssignments = pgTable(
  "content_assignments",
  {
    contentItemId: uuid("content_item_id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").notNull(),
    revision: integer("revision").notNull().default(0),
    assigneeMemberId: text("assignee_member_id"),
    assigneeUserId: text("assignee_user_id"),
    assigneeName: text("assignee_name"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("content_assignments_org_assignee_idx").on(t.orgId, t.assigneeUserId, t.contentItemId),
    foreignKey({
      name: "content_assignments_item_org_brand_fk",
      columns: [t.orgId, t.brandId, t.contentItemId],
      foreignColumns: [contentItems.orgId, contentItems.brandId, contentItems.id],
    }).onDelete("cascade"),
    check("content_assignments_revision_check", sql`${t.revision} >= 0`),
    check(
      "content_assignments_identity_check",
      sql`(${t.assigneeMemberId} is null and ${t.assigneeUserId} is null and ${t.assigneeName} is null) or (${t.assigneeMemberId} is not null and length(${t.assigneeMemberId}) between 1 and 255 and ${t.assigneeUserId} is not null and ${t.assigneeName} is not null)`,
    ),
  ],
);

/** Append-only changes, committed with the assignment. No body or credential copies. */
export const contentAssignmentHistory = pgTable(
  "content_assignment_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").notNull(),
    contentItemId: uuid("content_item_id").notNull(),
    revision: integer("revision").notNull(),
    previousMemberId: text("previous_member_id"),
    previousName: text("previous_name"),
    assigneeMemberId: text("assignee_member_id"),
    assigneeName: text("assignee_name"),
    actorUserId: text("actor_user_id").notNull(),
    actorName: text("actor_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("content_assignment_history_org_id_idx").on(t.orgId),
    uniqueIndex("content_assignment_history_item_revision_idx").on(
      t.orgId,
      t.contentItemId,
      t.revision,
    ),
    foreignKey({
      name: "content_assignment_history_item_org_brand_fk",
      columns: [t.orgId, t.brandId, t.contentItemId],
      foreignColumns: [contentItems.orgId, contentItems.brandId, contentItems.id],
    }).onDelete("cascade"),
    check("content_assignment_history_revision_check", sql`${t.revision} > 0`),
  ],
);
