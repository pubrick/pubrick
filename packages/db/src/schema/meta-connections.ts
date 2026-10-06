import { META_CONNECTION_PROVIDERS } from "@pubrick/shared";
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

/** Expiring server-owned state. Temporary Page choices are encrypted, never workspace export data. */
export const metaAuthorizationRequests = pgTable(
  "meta_authorization_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").notNull(),
    provider: text("provider", { enum: META_CONNECTION_PROVIDERS }).notNull(),
    applicationId: text("application_id").notNull(),
    redirectUri: text("redirect_uri").notNull(),
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    stateHash: text("state_hash").notNull(),
    channelId: uuid("channel_id"),
    expectedGeneration: integer("expected_generation"),
    expectedTarget: text("expected_target"),
    name: text("name").notNull(),
    locale: text("locale", { enum: ["en", "es", "ru", "pt"] }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    pageSelectionEncrypted: text("page_selection_encrypted"),
    pageSelectionConsumedAt: timestamp("page_selection_consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("meta_authorization_state_hash_idx").on(t.stateHash),
    index("meta_authorization_org_expiry_idx").on(t.orgId, t.expiresAt),
    foreignKey({
      name: "meta_authorization_brand_org_fk",
      columns: [t.orgId, t.brandId],
      foreignColumns: [brands.orgId, brands.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "meta_authorization_channel_brand_org_fk",
      columns: [t.orgId, t.brandId, t.channelId],
      foreignColumns: [channels.orgId, channels.brandId, channels.id],
    }).onDelete("cascade"),
    enumCheck("meta_authorization_provider_check", t.provider, META_CONNECTION_PROVIDERS),
    check("meta_authorization_application_check", sql`${t.applicationId} ~ '^[1-9][0-9]{0,30}$'`),
    check(
      "meta_authorization_callback_check",
      sql`length(${t.redirectUri}) between 1 and 2048 and ${t.redirectUri} ~ '^https://[^[:space:]]+$'`,
    ),
    enumCheck("meta_authorization_locale_check", t.locale, ["en", "es", "ru", "pt"]),
    check("meta_authorization_hash_check", sql`${t.stateHash} ~ '^[a-f0-9]{64}$'`),
    check(
      "meta_authorization_actor_check",
      sql`length(${t.userId}) between 1 and 200 and length(${t.sessionId}) between 1 and 200`,
    ),
    check("meta_authorization_name_check", sql`length(${t.name}) between 1 and 200`),
    check(
      "meta_authorization_expiry_check",
      sql`${t.expiresAt} > ${t.createdAt} and ${t.expiresAt} <= ${t.createdAt} + interval '10 minutes'`,
    ),
    check(
      "meta_authorization_intent_check",
      sql`
    (${t.channelId} is null and ${t.expectedGeneration} is null and ${t.expectedTarget} is null)
    or (${t.channelId} is not null and ${t.expectedGeneration} is not null and ${t.expectedTarget} is not null and ${t.expectedGeneration} >= 0 and
      ((${t.provider} = 'threads' and ${t.expectedTarget} ~ '^threads:[1-9][0-9]{0,30}$')
       or (${t.provider} = 'instagram_native' and ${t.expectedTarget} ~ '^instagram:[1-9][0-9]{0,30}$')
       or (${t.provider} = 'facebook_page' and ${t.expectedTarget} ~ '^facebook-page:[1-9][0-9]{0,30}$')))
  `,
    ),
    check(
      "meta_authorization_page_selection_check",
      sql`
    (${t.pageSelectionEncrypted} is null or (${t.provider} = 'facebook_page' and ${t.consumedAt} is not null and ${t.pageSelectionConsumedAt} is null))
    and (${t.pageSelectionConsumedAt} is null or (${t.provider} = 'facebook_page' and ${t.consumedAt} is not null and ${t.pageSelectionEncrypted} is null))
  `,
    ),
  ],
);
