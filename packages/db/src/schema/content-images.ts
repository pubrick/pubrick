import { CONTENT_IMAGE_ALIGNMENTS } from "@pubrick/shared";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { contentItems } from "./content-items.js";
import { enumCheck } from "./enum-check.js";
import { feedEntries } from "./feeds.js";
import { mediaAssets } from "./media.js";

/** Images are positioned beside the plain-text body, never embedded in it. */
export const contentImageSlots = pgTable(
  "content_image_slots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").notNull(),
    contentItemId: uuid("content_item_id").notNull(),
    mediaId: uuid("media_id").notNull(),
    /** Zero-based index of the nonempty paragraph after which the image appears. */
    afterParagraph: integer("after_paragraph").notNull(),
    alt: text("alt").notNull(),
    caption: text("caption"),
    alignment: text("alignment", { enum: CONTENT_IMAGE_ALIGNMENTS }).notNull().default("center"),
    needsReview: boolean("needs_review").notNull().default(false),
  },
  (t) => [
    foreignKey({
      name: "content_image_slots_item_brand_fk",
      columns: [t.orgId, t.brandId, t.contentItemId],
      foreignColumns: [contentItems.orgId, contentItems.brandId, contentItems.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "content_image_slots_media_brand_fk",
      columns: [t.orgId, t.brandId, t.mediaId],
      foreignColumns: [mediaAssets.orgId, mediaAssets.brandId, mediaAssets.id],
    }).onDelete("no action"),
    unique("content_image_slots_item_paragraph_key").on(t.contentItemId, t.afterParagraph),
    index("content_image_slots_media_id_idx").on(t.mediaId),
    check("content_image_slots_paragraph_check", sql`${t.afterParagraph} >= 0`),
    check("content_image_slots_alt_check", sql`length(btrim(${t.alt})) BETWEEN 1 AND 300`),
    check(
      "content_image_slots_caption_check",
      sql`${t.caption} IS NULL OR length(${t.caption}) <= 500`,
    ),
    enumCheck("content_image_slots_alignment_check", t.alignment, CONTENT_IMAGE_ALIGNMENTS),
  ],
);

/** Feed snapshots retain exactly the images visible when the entry was published. */
export const feedEntryImages = pgTable(
  "feed_entry_images",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").notNull(),
    feedEntryId: uuid("feed_entry_id").notNull(),
    mediaId: uuid("media_id").notNull(),
    afterParagraph: integer("after_paragraph").notNull(),
    alt: text("alt").notNull(),
    caption: text("caption"),
    alignment: text("alignment", { enum: CONTENT_IMAGE_ALIGNMENTS }).notNull().default("center"),
    position: integer("position").notNull(),
  },
  (t) => [
    foreignKey({
      name: "feed_entry_images_entry_brand_fk",
      columns: [t.orgId, t.brandId, t.feedEntryId],
      foreignColumns: [feedEntries.orgId, feedEntries.brandId, feedEntries.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "feed_entry_images_media_brand_fk",
      columns: [t.orgId, t.brandId, t.mediaId],
      foreignColumns: [mediaAssets.orgId, mediaAssets.brandId, mediaAssets.id],
    }).onDelete("no action"),
    unique("feed_entry_images_entry_position_key").on(t.feedEntryId, t.position),
    unique("feed_entry_images_entry_paragraph_key").on(t.feedEntryId, t.afterParagraph),
    index("feed_entry_images_media_id_idx").on(t.mediaId),
    check("feed_entry_images_paragraph_check", sql`${t.afterParagraph} >= 0`),
    check("feed_entry_images_position_check", sql`${t.position} >= 0`),
    check("feed_entry_images_alt_check", sql`length(btrim(${t.alt})) BETWEEN 1 AND 300`),
    check(
      "feed_entry_images_caption_check",
      sql`${t.caption} IS NULL OR length(${t.caption}) <= 500`,
    ),
    enumCheck("feed_entry_images_alignment_check", t.alignment, CONTENT_IMAGE_ALIGNMENTS),
  ],
);
