import { Injectable, NotFoundException } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  CONTENT_STATUSES,
  type ContentStatus,
  type PromptRevisionCreate,
  type PromptRevisionUsageDto,
  type PromptRole,
  RUN_STATUSES,
  type RunStatus,
} from "@pubrick/shared";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";

const COLUMNS = {
  id: schema.promptRevisions.id,
  role: schema.promptRevisions.role,
  version: schema.promptRevisions.version,
  guidance: schema.promptRevisions.guidance,
  createdAt: schema.promptRevisions.createdAt,
};

/** Shared by the API and its non-UTC database regression test. */
export function pinnedRunGroups(
  database: typeof db,
  orgId: string,
  role: PromptRole,
  revisionId: string,
  days: 7 | 30 | 90,
) {
  return database
    .select({
      runStatus: schema.pipelineRuns.status,
      itemStatus: schema.contentItems.status,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.pipelineRuns)
    .leftJoin(
      schema.contentItems,
      and(
        eq(schema.contentItems.id, schema.pipelineRuns.contentItemId),
        eq(schema.contentItems.orgId, orgId),
      ),
    )
    .where(
      and(
        eq(schema.pipelineRuns.orgId, orgId),
        // Both `created_at` and its DB default are naive timestamps. Keep
        // the cutoff in the same PostgreSQL session clock, including when
        // the server is configured outside UTC.
        sql`${schema.pipelineRuns.createdAt} >= now()::timestamp - (${days} * interval '1 day')`,
        sql`${schema.pipelineRuns.guidanceSnapshot} -> ${role} ->> 'revisionId' = ${revisionId}`,
      ),
    )
    .groupBy(schema.pipelineRuns.status, schema.contentItems.status);
}

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

  async usage(
    orgId: string,
    role: PromptRole,
    revisionId: string,
    days: 7 | 30 | 90,
  ): Promise<PromptRevisionUsageDto> {
    const revision = await db
      .select({ id: schema.promptRevisions.id })
      .from(schema.promptRevisions)
      .where(
        and(
          eq(schema.promptRevisions.orgId, orgId),
          eq(schema.promptRevisions.role, role),
          eq(schema.promptRevisions.id, revisionId),
        ),
      )
      .limit(1);
    if (!revision[0]) throw new NotFoundException("Prompt revision not found");

    const groups = await pinnedRunGroups(db, orgId, role, revisionId, days);

    const runsByStatus = Object.fromEntries(RUN_STATUSES.map((status) => [status, 0])) as Record<
      RunStatus,
      number
    >;
    const currentItemStatuses = Object.fromEntries(
      CONTENT_STATUSES.map((status) => [status, 0]),
    ) as Record<ContentStatus, number>;
    let runCount = 0;
    let withoutCurrentItem = 0;
    for (const group of groups) {
      runCount += group.count;
      runsByStatus[group.runStatus] += group.count;
      if (group.itemStatus) currentItemStatuses[group.itemStatus] += group.count;
      else withoutCurrentItem += group.count;
    }
    return {
      revisionId,
      role,
      days,
      runCount,
      runsByStatus,
      currentItemStatuses,
      withoutCurrentItem,
    };
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
