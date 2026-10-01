import {
  CONTENT_ORIGINS,
  CONTENT_REUSE_OPERATIONS,
  CONTENT_REUSE_TARGET_KINDS,
} from "@pubrick/shared";
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
  varchar,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { brands } from "./content.js";
import { enumCheck } from "./enum-check.js";
import { pipelineRuns } from "./generation.js";

/** Lifetime session admission audit; resource UUIDs survive individual resource deletion. */
export const contentReuseOperations = pgTable(
  "content_reuse_operations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").notNull(),
    operation: text("operation", { enum: CONTENT_REUSE_OPERATIONS }).notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 128 }).notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    hashVersion: text("hash_version").notNull(),
    rootSourceId: uuid("root_source_id").notNull(),
    rootSourceRevision: integer("root_source_revision").notNull(),
    requestTargetKind: text("request_target_kind", { enum: CONTENT_REUSE_TARGET_KINDS }).notNull(),
    requestTargetId: uuid("request_target_id").notNull(),
    resultRunId: uuid("result_run_id").notNull(),
    consentingActorId: text("consenting_actor_id").notNull(),
    consentVersion: text("consent_version").notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("content_reuse_operations_replay_idx").on(t.orgId, t.operation, t.idempotencyKey),
    index("content_reuse_operations_org_idx").on(t.orgId),
    foreignKey({
      name: "content_reuse_operations_brand_fk",
      columns: [t.orgId, t.brandId],
      foreignColumns: [brands.orgId, brands.id],
    }).onDelete("cascade"),
    // The reviewed operation literal contains a hyphen, outside enumCheck's safe literal grammar.
    check(
      "content_reuse_operations_operation_check",
      sql`${t.operation} in ('reuse', 'reuse-retry')`,
    ),
    enumCheck(
      "content_reuse_operations_request_target_kind_check",
      t.requestTargetKind,
      CONTENT_REUSE_TARGET_KINDS,
    ),
    check(
      "content_reuse_operations_target_check",
      sql`(${t.operation} = 'reuse' and ${t.requestTargetKind} = 'content' and ${t.requestTargetId} = ${t.rootSourceId}) or (${t.operation} = 'reuse-retry' and ${t.requestTargetKind} = 'run')`,
    ),
    check(
      "content_reuse_operations_key_check",
      sql`${t.idempotencyKey} ~ '^[A-Za-z0-9._-]{8,128}$'`,
    ),
    check(
      "content_reuse_operations_hash_check",
      sql`${t.requestHash} ~ '^[a-f0-9]{64}$' and ${t.hashVersion} = 'parsed-dto-v1'`,
    ),
    check("content_reuse_operations_revision_check", sql`${t.rootSourceRevision} >= 0`),
    check(
      "content_reuse_operations_consent_check",
      sql`${t.consentVersion} = 'byok-paid-generation-v1' and length(${t.consentingActorId}) between 1 and 255`,
    ),
  ],
);

/** One source snapshot per derived run. No source FK, body copy or copied authorship evidence. */
export const runSourceLineage = pgTable(
  "run_source_lineage",
  {
    derivedRunId: uuid("derived_run_id").primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").notNull(),
    sourceContentId: uuid("source_content_id").notNull(),
    sourceRevision: integer("source_revision").notNull(),
    sourceTitle: text("source_title"),
    sourceDigest: varchar("source_digest", { length: 64 }),
    sourceOrigin: text("source_origin", { enum: CONTENT_ORIGINS }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull().defaultNow(),
    sourceRedactedAt: timestamp("source_redacted_at", { withTimezone: true }),
  },
  (t) => [
    index("run_source_lineage_source_idx").on(
      t.orgId,
      t.brandId,
      t.sourceContentId,
      t.derivedRunId,
    ),
    foreignKey({
      name: "run_source_lineage_brand_fk",
      columns: [t.orgId, t.brandId],
      foreignColumns: [brands.orgId, brands.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "run_source_lineage_run_fk",
      columns: [t.orgId, t.brandId, t.derivedRunId],
      foreignColumns: [pipelineRuns.orgId, pipelineRuns.brandId, pipelineRuns.id],
    }).onDelete("cascade"),
    check("run_source_lineage_revision_check", sql`${t.sourceRevision} >= 0`),
    check("run_source_lineage_digest_check", sql`${t.sourceDigest} ~ '^[a-f0-9]{64}$'`),
    enumCheck("run_source_lineage_source_origin_check", t.sourceOrigin, CONTENT_ORIGINS),
    check(
      "run_source_lineage_redaction_check",
      sql`(${t.sourceRedactedAt} is null and ${t.sourceDigest} is not null and ${t.sourceOrigin} is not null) or (${t.sourceRedactedAt} is not null and ${t.sourceTitle} is null and ${t.sourceDigest} is null and ${t.sourceOrigin} is null)`,
    ),
  ],
);
