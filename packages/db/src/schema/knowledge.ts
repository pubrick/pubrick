import { KNOWLEDGE_CATEGORIES } from "@pubrick/shared";
import { boolean, index, pgTable, text, timestamp, uuid, vector } from "drizzle-orm/pg-core";
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
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .$onUpdate(() => new Date())
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index("knowledge_entries_org_brand_idx").on(t.orgId, t.brandId),
    enumCheck("knowledge_entries_category_check", t.category, KNOWLEDGE_CATEGORIES),
  ],
);
