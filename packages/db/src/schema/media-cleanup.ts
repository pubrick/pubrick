import { sql } from "drizzle-orm";
import { bigint, check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { enumCheck } from "./enum-check.js";

export const MEDIA_CLEANUP_ERRORS = [
  "asset_exists",
  "lease_exhausted",
  "permission",
  "storage_unavailable",
  "invalid_path",
] as const;

/** Durable deletion proof survives its tenant and the media_assets cascade. */
export const mediaCleanupWork = pgTable(
  "media_cleanup_work",
  {
    assetId: uuid("asset_id").primaryKey(),
    orgId: text("org_id").notNull(),
    kind: text("kind", { enum: ["image", "video"] }).notNull(),
    byteSize: bigint("byte_size", { mode: "bigint" }),
    state: text("state", { enum: ["pending", "completed", "operator_action"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    lastError: text("last_error", { enum: MEDIA_CLEANUP_ERRORS }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("media_cleanup_storage_idx").on(t.orgId, t.assetId).where(sql`${t.state} <> 'completed'`),
    check("media_cleanup_work_byte_size_check", sql`${t.byteSize} > 0`),
    index("media_cleanup_pending_idx")
      .on(t.nextAttemptAt, t.assetId)
      .where(sql`${t.state} = 'pending'`),
    index("media_cleanup_completed_idx")
      .on(t.completedAt, t.assetId)
      .where(sql`${t.state} = 'completed'`),
    enumCheck("media_cleanup_work_kind_check", t.kind, ["image", "video"]),
    enumCheck("media_cleanup_work_state_check", t.state, [
      "pending",
      "completed",
      "operator_action",
    ]),
    check("media_cleanup_work_attempts_check", sql`${t.attempts} BETWEEN 0 AND 8`),
    check(
      "media_cleanup_work_lease_check",
      sql`(${t.leaseUntil} IS NULL) = (${t.leaseToken} IS NULL)`,
    ),
    check(
      "media_cleanup_work_completed_check",
      sql`(${t.state} = 'completed') = (${t.completedAt} IS NOT NULL)`,
    ),
    enumCheck("media_cleanup_work_last_error_check", t.lastError, MEDIA_CLEANUP_ERRORS),
  ],
);
