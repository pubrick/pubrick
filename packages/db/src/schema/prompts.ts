import { PROMPT_ROLES } from "@pubrick/shared";
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
import { enumCheck } from "./enum-check.js";

/** Append-only organization guidance; the greatest version is active. */
export const promptRevisions = pgTable(
  "prompt_revisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    role: text("role", { enum: PROMPT_ROLES }).notNull(),
    version: integer("version").notNull(),
    guidance: text("guidance").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("prompt_revisions_org_role_version_idx").on(t.orgId, t.role, t.version),
    index("prompt_revisions_org_role_created_idx").on(t.orgId, t.role, t.createdAt),
    enumCheck("prompt_revisions_role_check", t.role, PROMPT_ROLES),
    check("prompt_revisions_version_positive_check", sql`${t.version} > 0`),
    check("prompt_revisions_guidance_limit_check", sql`char_length(${t.guidance}) <= 6000`),
  ],
);
