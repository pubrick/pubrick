import { schema } from "@pubrick/db";
import { asc, eq, inArray } from "drizzle-orm";
import type { db } from "./db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Missing tenants are ordinary for delayed worker jobs, not retryable errors. */
export async function holdOrganization(tx: Tx, orgId: string): Promise<boolean> {
  const [organization] = await tx
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.id, orgId))
    .for("key share");
  return !!organization;
}

/** Bulk recovery locks candidate tenants in one order before any child rows. */
export async function holdOrganizations(tx: Tx, orgIds: string[]): Promise<string[]> {
  if (!orgIds.length) return [];
  const rows = await tx
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(inArray(schema.organization.id, [...new Set(orgIds)]))
    .orderBy(asc(schema.organization.id))
    .for("key share");
  return rows.map((row) => row.id);
}
