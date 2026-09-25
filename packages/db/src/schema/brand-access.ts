import { foreignKey, index, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";
import { member, organization } from "./auth.js";
import { brands } from "./content.js";

/** A member's explicit access to one brand within their organization. */
export const brandAccess = pgTable(
  "brand_access",
  {
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    brandId: uuid("brand_id").notNull(),
    memberId: text("member_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.brandId, t.memberId] }),
    index("brand_access_org_id_idx").on(t.orgId),
    index("brand_access_member_id_idx").on(t.memberId),
    foreignKey({
      name: "brand_access_brand_org_fk",
      columns: [t.orgId, t.brandId],
      foreignColumns: [brands.orgId, brands.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "brand_access_member_org_fk",
      columns: [t.orgId, t.memberId],
      foreignColumns: [member.organizationId, member.id],
    }).onDelete("cascade"),
  ],
);
