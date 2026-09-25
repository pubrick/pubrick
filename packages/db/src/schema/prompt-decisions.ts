import { PROMPT_ROLES } from "@pubrick/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
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
import { enumCheck } from "./enum-check.js";
import { roleTemplateRevisions } from "./role-templates.js";

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
    uniqueIndex("prompt_decisions_org_id_idx").on(t.orgId, t.id),
    check("prompt_decisions_ordinal_positive_check", sql`${t.ordinal} > 0`),
    enumCheck("prompt_decisions_verdict_check", t.verdict, ["approved", "rejected"]),
  ],
);

/** One verified role-template selection per review act; no historical inference. */
export const promptDecisionTemplateRevisions = pgTable(
  "prompt_decision_template_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    decisionId: uuid("decision_id").notNull(),
    role: text("role", { enum: PROMPT_ROLES }).notNull(),
    revisionId: uuid("revision_id"),
    version: integer("version"),
    isDefault: boolean("is_default").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("prompt_decision_template_revisions_decision_role_idx").on(t.decisionId, t.role),
    index("prompt_decision_template_revisions_cohort_idx").on(
      t.orgId,
      t.role,
      t.isDefault,
      t.revisionId,
      t.decidedAt,
      t.decisionId,
    ),
    foreignKey({
      name: "prompt_decision_template_revisions_decision_fk",
      columns: [t.orgId, t.decisionId],
      foreignColumns: [promptDecisions.orgId, promptDecisions.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "prompt_decision_template_revisions_revision_fk",
      columns: [t.orgId, t.role, t.revisionId],
      foreignColumns: [
        roleTemplateRevisions.orgId,
        roleTemplateRevisions.role,
        roleTemplateRevisions.id,
      ],
    }).onDelete("no action"),
    enumCheck("prompt_decision_template_revisions_role_check", t.role, PROMPT_ROLES),
    check(
      "prompt_decision_template_revisions_selection_check",
      sql`(${t.isDefault} AND ${t.revisionId} IS NULL AND ${t.version} IS NULL) OR (NOT ${t.isDefault} AND ${t.revisionId} IS NOT NULL AND ${t.version} IS NOT NULL AND ${t.version} > 0)`,
    ),
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
