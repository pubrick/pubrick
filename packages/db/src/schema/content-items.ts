import { sql } from "drizzle-orm";
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { brands, channels } from "./content.js";

/** Draft lifecycle. `approved` means every adaptation was queued or scheduled. */
export const CONTENT_STATUSES = ["draft", "approved", "rejected", "published", "failed"] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

/** Per-channel delivery lifecycle. */
export const ADAPTATION_STATUSES = [
  "pending",
  "scheduled",
  "queued",
  "publishing",
  "published",
  "failed",
] as const;
export type AdaptationStatus = (typeof ADAPTATION_STATUSES)[number];

export const PUBLICATION_STATUSES = ["published", "failed"] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

export const contentItems = pgTable(
  "content_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    title: text("title"),
    body: text("body").notNull(),
    status: text("status", { enum: CONTENT_STATUSES }).notNull().default("draft"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("content_items_org_id_idx").on(t.orgId),
    index("content_items_brand_id_idx").on(t.brandId),
  ],
);

export const adaptations = pgTable(
  "adaptations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contentItemId: uuid("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    /** Per-channel override; falls back to the content item body when null. */
    body: text("body"),
    status: text("status", { enum: ADAPTATION_STATUSES }).notNull().default("pending"),
    scheduledAt: timestamp("scheduled_at"),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .$onUpdate(() => new Date())
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("adaptations_org_id_idx").on(t.orgId),
    index("adaptations_content_item_id_idx").on(t.contentItemId),
    index("adaptations_channel_id_idx").on(t.channelId),
  ],
);

/** Terminal outcome log: one row per delivery attempt that ended for good. */
export const publications = pgTable(
  "publications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    adaptationId: uuid("adaptation_id")
      .notNull()
      .references(() => adaptations.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    status: text("status", { enum: PUBLICATION_STATUSES }).notNull(),
    /** Platform message id; null when the platform returned no usable id. */
    externalId: text("external_id"),
    externalUrl: text("external_url"),
    error: text("error"),
    attempt: integer("attempt").notNull().default(1),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("publications_org_id_idx").on(t.orgId),
    index("publications_adaptation_id_idx").on(t.adaptationId),
    /**
     * At most one PUBLISHED RECORD per adaptation, as a database invariant
     * rather than a convention.
     *
     * This bounds the bookkeeping, not the sending. The worker's guards
     * (checking for an existing published publication, completing rather than
     * retrying a job once a platform accepted the post) are read-then-writes
     * that two workers can interleave, and this index is what stops such a
     * race from producing two contradictory `published` rows. It cannot stop a
     * duplicate POST: the send happens between the check and the insert, so a
     * process killed in that window leaves no record and a later attempt sends
     * again. Preventing that needs a platform-side idempotency key.
     *
     * Partial, so the many `failed` rows one adaptation may accumulate across
     * retries are unaffected.
     */
    uniqueIndex("publications_one_published_per_adaptation")
      .on(t.adaptationId)
      .where(sql`${t.status} = 'published'`),
  ],
);
