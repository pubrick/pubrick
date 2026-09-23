import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import type { PromptRevisionCreate, PromptRole } from "@pubrick/shared";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../db";

const COLUMNS = {
  id: schema.promptRevisions.id,
  role: schema.promptRevisions.role,
  version: schema.promptRevisions.version,
  guidance: schema.promptRevisions.guidance,
  createdAt: schema.promptRevisions.createdAt,
};

@Injectable()
export class PromptsRepository {
  /** Only saved guidance appears here; the built-in roles live in packages/ai. */
  list(orgId: string) {
    return db
      .selectDistinctOn([schema.promptRevisions.role], COLUMNS)
      .from(schema.promptRevisions)
      .where(eq(schema.promptRevisions.orgId, orgId))
      .orderBy(asc(schema.promptRevisions.role), desc(schema.promptRevisions.version));
  }

  history(orgId: string, role: PromptRole) {
    return db
      .select(COLUMNS)
      .from(schema.promptRevisions)
      .where(and(eq(schema.promptRevisions.orgId, orgId), eq(schema.promptRevisions.role, role)))
      .orderBy(desc(schema.promptRevisions.version))
      .limit(100);
  }

  async append(orgId: string, role: PromptRole, data: PromptRevisionCreate) {
    return db.transaction(async (tx) => {
      // The organization row is a stable lock even before the first revision.
      // It serializes two editors creating the next version at the same time.
      await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, orgId))
        .for("update");
      const current = await tx
        .select({ version: schema.promptRevisions.version })
        .from(schema.promptRevisions)
        .where(and(eq(schema.promptRevisions.orgId, orgId), eq(schema.promptRevisions.role, role)))
        .orderBy(desc(schema.promptRevisions.version))
        .limit(1);
      const rows = await tx
        .insert(schema.promptRevisions)
        .values({ orgId, role, version: (current[0]?.version ?? 0) + 1, guidance: data.guidance })
        .returning(COLUMNS);
      return rows[0];
    });
  }
}
