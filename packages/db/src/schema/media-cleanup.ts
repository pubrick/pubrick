import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/** Durable deletion proof survives its tenant and the media_assets cascade. */
export const mediaCleanupWork = pgTable(
  "media_cleanup_work",
  {
    assetId: uuid("asset_id").primaryKey(),
    orgId: text("org_id").notNull(),
    kind: text("kind", { enum: ["image", "video"] }).notNull(),
    state: text("state", { enum: ["pending", "completed", "operator_action"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    leaseToken: uuid("lease_token"),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("media_cleanup_pending_idx")
      .on(t.nextAttemptAt, t.assetId)
      .where(sql`${t.state} = 'pending'`),
    index("media_cleanup_completed_idx")
      .on(t.completedAt, t.assetId)
      .where(sql`${t.state} = 'completed'`),
    check("media_cleanup_kind_check", sql`${t.kind} IN ('image', 'video')`),
    check(
      "media_cleanup_state_check",
      sql`${t.state} IN ('pending', 'completed', 'operator_action')`,
    ),
    check("media_cleanup_attempts_check", sql`${t.attempts} BETWEEN 0 AND 8`),
    check("media_cleanup_lease_check", sql`(${t.leaseUntil} IS NULL) = (${t.leaseToken} IS NULL)`),
    check(
      "media_cleanup_completed_check",
      sql`(${t.state} = 'completed') = (${t.completedAt} IS NOT NULL)`,
    ),
    check(
      "media_cleanup_error_check",
      sql`${t.lastError} IS NULL OR ${t.lastError} IN ('asset_exists', 'lease_exhausted', 'permission', 'storage_unavailable', 'invalid_path')`,
    ),
  ],
);
