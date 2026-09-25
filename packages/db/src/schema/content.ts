import { type BrandLinkPolicy, PLATFORM_IDS } from "@pubrick/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { enumCheck } from "./enum-check.js";

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
    // AES-256-GCM blob produced by @pubrick/shared encryptJson; never exposed via API.
    credentialsEncrypted: text("credentials_encrypted"),
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
    check(
      "channels_credentials_mode_check",
      sql`(${t.platform} = 'vc_ru') = (${t.credentialsEncrypted} is null)`,
    ),
    check(
      "channels_metrics_auto_refresh_vk_check",
      sql`not ${t.metricsAutoRefresh} or ${t.platform} = 'vk'`,
    ),
  ],
);
