import {
  type BrandLinkPolicy,
  MANUAL_PLATFORM_IDS,
  PLATFORM_IDS,
  type PostingSlot,
} from "@pubrick/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { enumCheck, enumSqlLiterals } from "./enum-check.js";

export const brands = pgTable(
  "brands",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    voice: text("voice"),
    audience: text("audience"),
    contentLanguage: text("content_language").notNull().default("en"),
    linkPolicy: jsonb("link_policy").$type<BrandLinkPolicy>(),
    /** Explicit paid, advisory evidence review after an AI draft is saved. */
    automaticClaimEvidence: boolean("automatic_claim_evidence").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => new Date())
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("brands_org_id_idx").on(t.orgId),
    uniqueIndex("brands_org_id_id_idx").on(t.orgId, t.id),
  ],
);

export const channels = pgTable(
  "channels",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    platform: text("platform", { enum: PLATFORM_IDS }).notNull(),
    name: text("name").notNull(),
    /** Explicit per-channel opt-in. Only VK supports automatic metric reads. */
    metricsAutoRefresh: boolean("metrics_auto_refresh").default(false).notNull(),
    postingTimezone: text("posting_timezone"),
    postingSlots: jsonb("posting_slots").$type<PostingSlot[]>().default([]).notNull(),
    postingRevision: integer("posting_revision").default(0).notNull(),
    // AES-256-GCM blob produced by @pubrick/shared encryptJson; never exposed via API.
    credentialsEncrypted: text("credentials_encrypted"),
    /** Non-secret immutable destination for adapters with a canonical target. */
    connectionTarget: text("connection_target"),
    /** CAS fence for managed authorization, replacement and disconnect. */
    connectionGeneration: integer("connection_generation").default(0).notNull(),
    connectionAccount: text("connection_account"),
    /** Server-owned application lineage for managed Meta tokens; never user-editable. */
    connectionApplicationId: text("connection_application_id"),
    connectionScopes: text("connection_scopes"),
    connectionExpiresAt: timestamp("connection_expires_at", { withTimezone: true }),
    connectionConnectedAt: timestamp("connection_connected_at", { withTimezone: true }),
    connectionDisconnectedAt: timestamp("connection_disconnected_at", { withTimezone: true }),
    /** Last real platform verification, invalidated when credentials change. */
    healthOk: boolean("health_ok"),
    healthCheckedAt: timestamp("health_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => new Date())
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("channels_org_id_idx").on(t.orgId),
    index("channels_brand_id_idx").on(t.brandId),
    uniqueIndex("channels_org_brand_id_idx").on(t.orgId, t.brandId, t.id),
    check("channels_connection_generation_check", sql`${t.connectionGeneration} >= 0`),
    check(
      "channels_connection_application_check",
      sql`${t.connectionApplicationId} is null or ${t.connectionApplicationId} ~ '^[1-9][0-9]{0,30}$'`,
    ),
    check(
      "channels_meta_target_check",
      sql`(${t.platform} not in ('threads', 'instagram_native', 'facebook_page')) or
        (${t.connectionTarget} is not null and ${t.connectionApplicationId} is not null and
          ((${t.platform} = 'threads' and ${t.connectionTarget} ~ '^threads:[1-9][0-9]{0,30}$') or
           (${t.platform} = 'instagram_native' and ${t.connectionTarget} ~ '^instagram:[1-9][0-9]{0,30}$') or
           (${t.platform} = 'facebook_page' and ${t.connectionTarget} ~ '^facebook-page:[1-9][0-9]{0,30}$')))`,
    ),
    check(
      "channels_connection_account_check",
      sql`${t.connectionAccount} is null or length(${t.connectionAccount}) between 1 and 300`,
    ),
    check(
      "channels_connection_scopes_check",
      sql`${t.connectionScopes} is null or length(${t.connectionScopes}) <= 2048`,
    ),
    check(
      "channels_linkedin_target_check",
      sql`${t.platform} <> 'linkedin' or (${t.connectionTarget} is not null and ${t.connectionTarget} ~ '^urn:li:person:[A-Za-z0-9_-]{1,200}$')`,
    ),
    check(
      "channels_connection_target_check",
      sql`${t.connectionTarget} is null or length(${t.connectionTarget}) between 1 and 2048`,
    ),
    check(
      "channels_wordpress_target_check",
      sql`${t.platform} <> 'wordpress' or ${t.connectionTarget} is not null`,
    ),
    check("channels_posting_revision_check", sql`${t.postingRevision} >= 0`),
    check(
      "channels_posting_slots_check",
      sql`jsonb_typeof(${t.postingSlots}) = 'array' and jsonb_array_length(${t.postingSlots}) <= 70 and (jsonb_array_length(${t.postingSlots}) = 0 or ${t.postingTimezone} is not null)`,
    ),
    index("channels_health_due_idx").on(t.healthCheckedAt, t.id),
    check(
      "channels_health_result_pair_check",
      sql`${t.healthOk} is null or ${t.healthCheckedAt} is not null`,
    ),
    /**
     * The platform decides which adapter sends the post and which length limit
     * the body is checked against (`adaptationLimit`), and both are lookups
     * keyed by this string. A value outside the set resolves to no adapter and
     * no limit — see `enumCheck`.
     */
    enumCheck("channels_platform_check", t.platform, PLATFORM_IDS),
    /**
     * Existing Dzen rows may hold an encrypted token from before the manual
     * workflow. Preserve those bytes on upgrade; new Dzen channels are created
     * without credentials, and the API never reads legacy Dzen tokens to send.
     */
    check(
      "channels_credentials_mode_check",
      sql`${t.platform} in ('dzen', 'linkedin', 'threads', 'instagram_native', 'facebook_page') or ((${t.platform} in (${enumSqlLiterals(MANUAL_PLATFORM_IDS.filter((platform) => platform !== "dzen"))})) = (${t.credentialsEncrypted} is null))`,
    ),
    check(
      "channels_metrics_auto_refresh_vk_check",
      sql`not ${t.metricsAutoRefresh} or ${t.platform} = 'vk'`,
    ),
  ],
);
