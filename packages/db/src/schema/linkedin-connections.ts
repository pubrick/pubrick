import { LINKEDIN_AUTHORIZATION_LOCALES } from "@pubrick/shared";
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
import { brands, channels } from "./content.js";
import { enumCheck } from "./enum-check.js";

/** Short-lived server-owned OAuth state; no raw state/code/token belongs in this table. */
export const linkedinAuthorizationRequests = pgTable(
  "linkedin_authorization_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").notNull(),
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    stateHash: text("state_hash").notNull(),
    nonceEncrypted: text("nonce_encrypted").notNull(),
    channelId: uuid("channel_id"),
    expectedGeneration: integer("expected_generation"),
    expectedTarget: text("expected_target"),
    name: text("name").notNull(),
    locale: text("locale", { enum: LINKEDIN_AUTHORIZATION_LOCALES }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("linkedin_authorization_state_hash_idx").on(t.stateHash),
    index("linkedin_authorization_org_expiry_idx").on(t.orgId, t.expiresAt),
    foreignKey({
      name: "linkedin_authorization_brand_org_fk",
      columns: [t.orgId, t.brandId],
      foreignColumns: [brands.orgId, brands.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "linkedin_authorization_channel_brand_org_fk",
      columns: [t.orgId, t.brandId, t.channelId],
      foreignColumns: [channels.orgId, channels.brandId, channels.id],
    }).onDelete("cascade"),
    check("linkedin_authorization_hash_check", sql`${t.stateHash} ~ '^[a-f0-9]{64}$'`),
    check(
      "linkedin_authorization_actor_check",
      sql`length(${t.userId}) between 1 and 200 and length(${t.sessionId}) between 1 and 200`,
    ),
    check("linkedin_authorization_name_check", sql`length(${t.name}) between 1 and 200`),
    enumCheck(
      "linkedin_authorization_requests_locale_check",
      t.locale,
      LINKEDIN_AUTHORIZATION_LOCALES,
    ),
    check(
      "linkedin_authorization_intent_check",
      sql`(${t.channelId} is null and ${t.expectedGeneration} is null and ${t.expectedTarget} is null) or (${t.channelId} is not null and ${t.expectedGeneration} is not null and ${t.expectedGeneration} >= 0 and ${t.expectedTarget} is not null and ${t.expectedTarget} ~ '^urn:li:person:[A-Za-z0-9_-]{1,200}$')`,
    ),
    check(
      "linkedin_authorization_expiry_check",
      sql`${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '10 minutes'`,
    ),
  ],
);
