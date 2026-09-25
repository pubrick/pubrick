import { PROMPT_ROLES } from "@pubrick/shared";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { enumCheck } from "./enum-check.js";

/** A human review verdict, retained even when its draft or run is deleted. */
export const promptDecisions = pgTable(
  "prompt_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contentItemId: uuid("content_item_id").notNull(),
    /** Per-item causal order, assigned while the content item row is locked. */
    ordinal: integer("ordinal").notNull(),
    runId: uuid("run_id"),
    verdict: text("verdict", { enum: ["approved", "rejected"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("prompt_decisions_org_item_ordinal_idx").on(t.orgId, t.contentItemId, t.ordinal),
    check("prompt_decisions_ordinal_positive_check", sql`${t.ordinal} > 0`),
    enumCheck("prompt_decisions_verdict_check", t.verdict, ["approved", "rejected"]),
  ],
);

/** Only independently verified, same-organization pinned revisions are linked. */
export const promptDecisionRevisions = pgTable(
  "prompt_decision_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    decisionId: uuid("decision_id")
      .notNull()
      .references(() => promptDecisions.id, { onDelete: "cascade" }),
    role: text("role", { enum: PROMPT_ROLES }).notNull(),
    revisionId: uuid("revision_id").notNull(),
    version: integer("version").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("prompt_decision_revisions_decision_role_idx").on(t.decisionId, t.role),
    index("prompt_decision_revisions_revision_time_idx").on(
      t.orgId,
      t.role,
      t.revisionId,
      t.decidedAt,
      t.decisionId,
    ),
    enumCheck("prompt_decision_revisions_role_check", t.role, PROMPT_ROLES),
    check("prompt_decision_revisions_version_positive_check", sql`${t.version} > 0`),
  ],
);
