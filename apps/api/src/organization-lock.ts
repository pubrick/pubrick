import { NotFoundException } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { eq } from "drizzle-orm";
import type { db } from "./db";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Hold the tenant before child locks whenever a later write checks its FK. */
export async function holdOrganization(tx: Tx, orgId: string): Promise<void> {
  const [organization] = await tx
    .select({ id: schema.organization.id })
    .from(schema.organization)
    .where(eq(schema.organization.id, orgId))
    .for("key share");
  if (!organization) throw new NotFoundException("Organization not found");
}
