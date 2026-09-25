import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { brands } from "./content.js";
import { enumCheck } from "./enum-check.js";

export const MEDIA_KINDS = ["image", "video"] as const;

/** Normalized JPEGs and bounded uploaded MP4s on the shared media volume. */
export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind", { enum: MEDIA_KINDS }).notNull().default("image"),
    mimeType: text("mime_type").notNull().default("image/jpeg"),
    width: integer("width"),
    height: integer("height"),
    byteSize: integer("byte_size").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("media_assets_org_brand_created_idx").on(t.orgId, t.brandId, t.createdAt.desc()),
    uniqueIndex("media_assets_org_brand_id_idx").on(t.orgId, t.brandId, t.id),
    enumCheck("media_assets_kind_check", t.kind, MEDIA_KINDS),
    check(
      "media_assets_shape_check",
      sql`(${t.kind} = 'image' AND ${t.mimeType} = 'image/jpeg' AND ${t.width} IS NOT NULL AND ${t.height} IS NOT NULL AND ${t.width} > 0 AND ${t.height} > 0) OR (${t.kind} = 'video' AND ${t.mimeType} = 'video/mp4' AND ${t.width} IS NULL AND ${t.height} IS NULL)`,
    ),
    check("media_assets_byte_size_check", sql`${t.byteSize} > 0`),
  ],
);
