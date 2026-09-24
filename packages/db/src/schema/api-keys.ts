import { sql } from "drizzle-orm";
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organization, user } from "./auth.js";

export const organizationApiKeys = pgTable(
  "organization_api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    scope: text("scope").notNull(),
    createdBy: text("created_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("organization_api_keys_org_id_idx").on(t.orgId),
    uniqueIndex("organization_api_keys_prefix_idx").on(t.prefix),
    uniqueIndex("organization_api_keys_hash_idx").on(t.keyHash),
    check("organization_api_keys_scope_check", sql`${t.scope} = 'content:read'`),
    check("organization_api_keys_name_check", sql`char_length(${t.name}) BETWEEN 1 AND 80`),
  ],
);
