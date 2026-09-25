import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { brands } from "./content.js";

/** A brand-owned note that may be used as attributed context in generation. */
export const knowledgeEntries = pgTable(
  "knowledge_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    category: text("category").notNull(),
    tags: text("tags").array().notNull().default([]),
    isActive: boolean("is_active").notNull().default(true),
    embedding: vector("embedding", { dimensions: 768 }),
    embeddingModel: text("embedding_model"),
    embeddingDimensions: integer("embedding_dimensions"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => new Date())
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("knowledge_entries_org_brand_idx").on(t.orgId, t.brandId),
    check(
      "knowledge_entries_category_check",
      sql`char_length(${t.category}) between 1 and 100 and ${t.category} = btrim(${t.category}) and ${t.category} !~ '[[:cntrl:]]' and ${t.category} !~ ('[' || chr(127) || '-' || chr(159) || ']')`,
    ),
    check(
      "knowledge_entries_embedding_metadata_check",
      sql`(${t.embedding} is null and ${t.embeddingModel} is null and ${t.embeddingDimensions} is null) or (${t.embedding} is not null and ${t.embeddingModel} is not null and ${t.embeddingDimensions} = 768)`,
    ),
  ],
);

/** Explicit per-brand consent and a durable cooldown for paid background indexing. */
export const knowledgeAutoIndex = pgTable(
  "knowledge_auto_index",
  {
    brandId: uuid("brand_id")
      .primaryKey()
      .references(() => brands.id, { onDelete: "cascade" }),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("knowledge_auto_index_org_enabled_idx").on(t.orgId, t.enabled)],
);
