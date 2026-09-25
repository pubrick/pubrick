import { type ContentType, type PlatformId, PROMPT_ROLES, type PromptRole } from "@pubrick/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth.js";
import { enumCheck } from "./enum-check.js";

/** A draft is an append-only source revision. Activation lives in a separate head. */
export const roleTemplateRevisions = pgTable(
  "role_template_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    role: text("role", { enum: PROMPT_ROLES }).notNull(),
    version: integer("version").notNull(),
    source: text("source").notNull(),
    sourceSha256: text("source_sha256").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("role_template_revisions_org_role_version_idx").on(t.orgId, t.role, t.version),
    uniqueIndex("role_template_revisions_org_role_id_idx").on(t.orgId, t.role, t.id),
    index("role_template_revisions_org_role_created_idx").on(t.orgId, t.role, t.createdAt),
    enumCheck("role_template_revisions_role_check", t.role, PROMPT_ROLES),
    check("role_template_revisions_version_check", sql`${t.version} > 0`),
    check(
      "role_template_revisions_source_check",
      sql`char_length(${t.source}) BETWEEN 1 AND 12000 AND octet_length(${t.source}) <= 49152 AND length(btrim(${t.source})) > 0`,
    ),
    check("role_template_revisions_sha_check", sql`${t.sourceSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

/** Missing row and null active ID both mean built-in, generation zero if missing. */
export const roleTemplateHeads = pgTable(
  "role_template_heads",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    role: text("role", { enum: PROMPT_ROLES }).notNull(),
    activeRevisionId: uuid("active_revision_id"),
    generation: integer("generation").notNull().default(0),
  },
  (t) => [
    primaryKey({ name: "role_template_heads_org_role_pk", columns: [t.orgId, t.role] }),
    foreignKey({
      name: "role_template_heads_active_revision_fk",
      columns: [t.orgId, t.role, t.activeRevisionId],
      foreignColumns: [
        roleTemplateRevisions.orgId,
        roleTemplateRevisions.role,
        roleTemplateRevisions.id,
      ],
    }).onDelete("no action"),
    enumCheck("role_template_heads_role_check", t.role, PROMPT_ROLES),
    check("role_template_heads_generation_check", sql`${t.generation} >= 0`),
  ],
);

/** A deployment opens this global gate only after old workers have drained. */
export const roleTemplateActivationGate = pgTable(
  "role_template_activation_gate",
  {
    id: integer("id").primaryKey().default(1),
    activationEnabled: boolean("activation_enabled").notNull().default(false),
    releaseEpoch: integer("release_epoch").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    check("role_template_activation_gate_singleton_check", sql`${t.id} = 1`),
    check("role_template_activation_gate_epoch_check", sql`${t.releaseEpoch} >= 0`),
    check(
      "role_template_activation_gate_enabled_epoch_check",
      sql`NOT ${t.activationEnabled} OR ${t.releaseEpoch} > 0`,
    ),
  ],
);

export type RoleTemplatePinnedSelection =
  | {
      kind: "default";
      revisionId: null;
      version: null;
      source: string;
      sourceSha256: string;
    }
  | {
      kind: "revision";
      revisionId: string;
      version: number;
      source: string;
      sourceSha256: string;
    };

export type RoleTemplateInstruction = { text: string; sha256: string };

/** JSONB type hint; the worker must validate this whole shape before use. */
export type RoleTemplateRunSnapshot = {
  formatVersion: 1;
  engineVersion: string;
  roles: Record<PromptRole, RoleTemplatePinnedSelection>;
  receipt: {
    contentType: ContentType;
    claimDateUtc: string;
    brand: {
      name: string;
      voice: string | null;
      audience: string | null;
      contentLanguage: string;
    };
    channels: Array<{ id: string; name: string; platform: PlatformId; limit: number }>;
  };
  receiptSha256: string;
  instructions: {
    researcher: RoleTemplateInstruction;
    writer: RoleTemplateInstruction;
    editor: RoleTemplateInstruction;
    factcheck: RoleTemplateInstruction;
    adapters: Record<string, RoleTemplateInstruction>;
  };
};
