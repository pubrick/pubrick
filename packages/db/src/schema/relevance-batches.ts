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
import { brands } from "./content.js";
import { enumCheck } from "./enum-check.js";

export const RELEVANCE_BATCH_STATUSES = [
  "queued",
  "running",
  "completed",
  "partial",
  "halted",
] as const;
export const RELEVANCE_BATCH_ITEM_STATUSES = [
  "queued",
  "running",
  "scored",
  "failed",
  "skipped",
] as const;
export const RELEVANCE_BATCH_ERRORS = [
  "no_api_key",
  "unreadable_key",
  "invalid_key",
  "model_not_found",
  "provider_refused",
  "model_failed",
] as const;

/** One explicit, bounded paid recheck. A partial unique index prevents overlapping brand spend. */
export const relevanceBatches = pgTable(
  "news_relevance_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    days: integer("days").notNull(),
    selectedCount: integer("selected_count").notNull(),
    processedCount: integer("processed_count").notNull().default(0),
    updatedCount: integer("updated_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    skippedCount: integer("skipped_count").notNull().default(0),
    unrecordedCalls: integer("unrecorded_calls").notNull().default(0),
    status: text("status", { enum: RELEVANCE_BATCH_STATUSES }).notNull().default("queued"),
    errorCode: text("error_code", { enum: RELEVANCE_BATCH_ERRORS }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("news_relevance_batches_org_brand_id_idx").on(t.orgId, t.brandId, t.id),
    uniqueIndex("news_relevance_batches_one_active_idx")
      .on(t.orgId, t.brandId)
      .where(sql`${t.status} IN ('queued', 'running')`),
    index("news_relevance_batches_history_idx").on(t.orgId, t.brandId, t.createdAt.desc()),
    check("news_relevance_batches_days_check", sql`${t.days} BETWEEN 1 AND 30`),
    check(
      "news_relevance_batches_counts_check",
      sql`${t.selectedCount} BETWEEN 1 AND 500 AND ${t.processedCount} BETWEEN 0 AND ${t.selectedCount} AND ${t.updatedCount} >= 0 AND ${t.failedCount} >= 0 AND ${t.skippedCount} >= 0 AND ${t.processedCount} = ${t.updatedCount} + ${t.failedCount} + ${t.skippedCount}`,
    ),
    check("news_relevance_batches_unrecorded_check", sql`${t.unrecordedCalls} >= 0`),
    enumCheck("news_relevance_batches_status_check", t.status, RELEVANCE_BATCH_STATUSES),
    enumCheck("news_relevance_batches_error_code_check", t.errorCode, RELEVANCE_BATCH_ERRORS),
  ],
);

/** Snapshot membership and result for every selected article. IDs survive deletion of source rows. */
export const relevanceBatchItems = pgTable(
  "news_relevance_batch_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id").notNull(),
    itemId: uuid("item_id").notNull(),
    status: text("status", { enum: RELEVANCE_BATCH_ITEM_STATUSES }).notNull().default("queued"),
    errorCode: text("error_code", { enum: RELEVANCE_BATCH_ERRORS }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("news_relevance_batch_items_once_idx").on(t.batchId, t.itemId),
    index("news_relevance_batch_items_scope_idx").on(t.orgId, t.brandId, t.batchId),
    foreignKey({
      name: "news_relevance_batch_items_batch_scope_fk",
      columns: [t.orgId, t.brandId, t.batchId],
      foreignColumns: [relevanceBatches.orgId, relevanceBatches.brandId, relevanceBatches.id],
    }).onDelete("cascade"),
    enumCheck("news_relevance_batch_items_status_check", t.status, RELEVANCE_BATCH_ITEM_STATUSES),
    enumCheck("news_relevance_batch_items_error_code_check", t.errorCode, RELEVANCE_BATCH_ERRORS),
  ],
);
