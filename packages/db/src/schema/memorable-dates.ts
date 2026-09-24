import type { CONTENT_TYPES } from "@pubrick/shared";
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
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { brands } from "./content.js";

/** Recurring editorial suggestions; these rows never dispatch generation or publication. */
export const memorableDates = pgTable(
  "memorable_dates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id")
      .notNull()
      .references(() => brands.id, { onDelete: "cascade" }),
    monthDay: text("month_day").notNull(),
    title: text("title").notNull(),
    leadDays: integer("lead_days").notNull().default(14),
    suggestedContentTypes: jsonb("suggested_content_types")
      .$type<(typeof CONTENT_TYPES)[number][]>()
      .notNull()
      .default([]),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("memorable_dates_org_brand_day_idx").on(t.orgId, t.brandId, t.monthDay),
    check(
      "memorable_dates_month_day_check",
      sql`case when ${t.monthDay} ~ '^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' then to_char(to_date('2000-' || ${t.monthDay}, 'YYYY-MM-DD'), 'MM-DD') = ${t.monthDay} else false end`,
    ),
    check("memorable_dates_title_nonempty", sql`length(trim(${t.title})) > 0`),
    check("memorable_dates_lead_days_range", sql`${t.leadDays} between 0 and 365`),
  ],
);
