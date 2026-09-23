import { KNOWLEDGE_CATEGORIES } from "@pubrick/shared";
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
import { enumCheck } from "./enum-check.js";

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
    category: text("category", { enum: KNOWLEDGE_CATEGORIES }).notNull(),
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
    enumCheck("knowledge_entries_category_check", t.category, KNOWLEDGE_CATEGORIES),
    check(
      "knowledge_entries_embedding_metadata_check",
      sql`(${t.embedding} is null and ${t.embeddingModel} is null and ${t.embeddingDimensions} is null) or (${t.embedding} is not null and ${t.embeddingModel} is not null and ${t.embeddingDimensions} = 768)`,
    ),
  ],
);
