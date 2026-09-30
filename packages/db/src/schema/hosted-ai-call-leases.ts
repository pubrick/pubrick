import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";

/** Physical dispatch fences only: never prompts, provider keys, or response data. */
export const hostedAiCallLeases = pgTable(
  "hosted_ai_call_leases",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"text" | "image" | "embedding" | "probe">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    dispatchDeadlineAt: timestamp("dispatch_deadline_at", { withTimezone: true }).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("hosted_ai_call_org_expiry_idx").on(t.orgId, t.leaseExpiresAt),
    index("hosted_ai_call_org_kind_expiry_idx").on(t.orgId, t.kind, t.leaseExpiresAt),
    check("hosted_ai_call_kind_check", sql`${t.kind} in ('text', 'image', 'embedding', 'probe')`),
    check(
      "hosted_ai_call_deadline_check",
      sql`${t.dispatchDeadlineAt} > ${t.createdAt} and ${t.leaseExpiresAt} = ${t.dispatchDeadlineAt} + interval '60 seconds'`,
    ),
  ],
);
