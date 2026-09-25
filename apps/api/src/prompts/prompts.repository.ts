import { Injectable, NotFoundException } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  CONTENT_STATUSES,
  type ContentStatus,
  type PromptDecisionHistoryDto,
  type PromptOutcomeComparisonDto,
  type PromptRevisionCreate,
  type PromptRevisionUsageDto,
  type PromptRole,
  RUN_STATUSES,
  type RunStatus,
} from "@pubrick/shared";
import { and, asc, desc, eq, exists, gte, inArray, sql } from "drizzle-orm";
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
  /** Compare observations for the same brand and run-start cohort, newest revision first. */
  async outcomes(
    orgId: string,
    brandId: string,
    role: PromptRole,
    days: 7 | 30 | 90,
  ): Promise<PromptOutcomeComparisonDto> {
    const [brand] = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    if (!brand) throw new NotFoundException("Brand not found");

    const revisions = await db
      .select({ id: schema.promptRevisions.id, version: schema.promptRevisions.version })
      .from(schema.promptRevisions)
      .where(and(eq(schema.promptRevisions.orgId, orgId), eq(schema.promptRevisions.role, role)))
      .orderBy(desc(schema.promptRevisions.version))
      .limit(100);
    const rows: PromptOutcomeComparisonDto["rows"] = revisions.map((revision) => ({
      revisionId: revision.id,
      version: revision.version,
      runCount: 0,
      succeededRuns: 0,
      publishedRuns: 0,
      currentItemStatuses: Object.fromEntries(CONTENT_STATUSES.map((status) => [status, 0])),
      withoutCurrentItem: 0,
      reviewActs: { approved: 0, rejected: 0 },
    }));
    if (revisions.length === 0) return { brandId, role, days, rows };

    const byRevision = new Map(rows.map((row) => [row.revisionId, row]));
    const revisionIds = revisions.map((revision) => revision.id);
    const runRevisionId = sql<string>`${schema.pipelineRuns.guidanceSnapshot} -> ${role} ->> 'revisionId'`;
    const runCohort = and(
      eq(schema.pipelineRuns.orgId, orgId),
      eq(schema.pipelineRuns.brandId, brandId),
      // pipeline_runs.created_at is a naive timestamp. Compare in the DB
      // session's clock, as the existing revision usage endpoint does.
      sql`${schema.pipelineRuns.createdAt} >= now()::timestamp - (${days} * interval '1 day')`,
      inArray(runRevisionId, revisionIds),
    );
    const hasReceipt = exists(
      db
        .select({ id: schema.publications.id })
        .from(schema.adaptations)
        .innerJoin(
          schema.publications,
          and(
            eq(schema.publications.adaptationId, schema.adaptations.id),
            eq(schema.publications.orgId, orgId),
            eq(schema.publications.status, "published"),
          ),
        )
        .where(
          and(
            eq(schema.adaptations.orgId, orgId),
            eq(schema.adaptations.contentItemId, schema.contentItems.id),
          ),
        ),
    );
    const groups = await db
      .select({
        revisionId: runRevisionId,
        runStatus: schema.pipelineRuns.status,
        itemStatus: schema.contentItems.status,
        hasReceipt,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.pipelineRuns)
      .leftJoin(
        schema.contentItems,
        and(
          eq(schema.contentItems.id, schema.pipelineRuns.contentItemId),
          eq(schema.contentItems.orgId, orgId),
          eq(schema.contentItems.brandId, brandId),
        ),
      )
      .where(runCohort)
      .groupBy(
        schema.pipelineRuns.guidanceSnapshot,
        schema.pipelineRuns.status,
        schema.contentItems.id,
        schema.contentItems.status,
      );
    for (const group of groups) {
      const row = byRevision.get(group.revisionId);
      if (!row) continue;
      row.runCount += group.count;
      if (group.runStatus === "succeeded") row.succeededRuns += group.count;
      if (group.itemStatus) {
        row.currentItemStatuses[group.itemStatus] =
          (row.currentItemStatuses[group.itemStatus] ?? 0) + group.count;
      } else row.withoutCurrentItem += group.count;
      if (group.hasReceipt) row.publishedRuns += group.count;
    }

    // The link table is append-only and unique per decision/role. A decision
    // keeps its verified revision even if the live draft is later deleted.
    const decisions = await db
      .select({
        revisionId: schema.promptDecisionRevisions.revisionId,
        verdict: schema.promptDecisions.verdict,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.promptDecisionRevisions)
      .innerJoin(
        schema.promptDecisions,
        and(
          eq(schema.promptDecisions.id, schema.promptDecisionRevisions.decisionId),
          eq(schema.promptDecisions.orgId, orgId),
        ),
      )
      .innerJoin(
        schema.pipelineRuns,
        and(
          eq(schema.pipelineRuns.id, schema.promptDecisions.runId),
          eq(schema.pipelineRuns.orgId, orgId),
        ),
      )
      .where(
        and(
          runCohort,
          eq(schema.promptDecisionRevisions.orgId, orgId),
          eq(schema.promptDecisionRevisions.role, role),
          sql`${schema.promptDecisionRevisions.revisionId}::text = ${runRevisionId}`,
        ),
      )
      .groupBy(schema.promptDecisionRevisions.revisionId, schema.promptDecisions.verdict);
    for (const decision of decisions) {
      const row = byRevision.get(decision.revisionId);
      if (row) row.reviewActs[decision.verdict] += decision.count;
    }
    return { brandId, role, days, rows };
  }

  async decisions(
    orgId: string,
    role: PromptRole,
    revisionId: string,
    days: 7 | 30 | 90,
    cursor: string | undefined,
  ): Promise<PromptDecisionHistoryDto> {
    const [revision] = await db
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
    if (!revision) throw new NotFoundException("Prompt revision not found");

    const scope = and(
      eq(schema.promptDecisionRevisions.orgId, orgId),
      eq(schema.promptDecisionRevisions.role, role),
      eq(schema.promptDecisionRevisions.revisionId, revisionId),
      gte(schema.promptDecisionRevisions.decidedAt, sql`now() - (${days} * interval '1 day')`),
    );
    const totals = await db
      .select({ verdict: schema.promptDecisions.verdict, count: sql<number>`count(*)::int` })
      .from(schema.promptDecisionRevisions)
      .innerJoin(
        schema.promptDecisions,
        and(
          eq(schema.promptDecisions.id, schema.promptDecisionRevisions.decisionId),
          eq(schema.promptDecisions.orgId, orgId),
        ),
      )
      .where(scope)
      .groupBy(schema.promptDecisions.verdict);
    const counts = { approved: 0, rejected: 0 };
    for (const total of totals) counts[total.verdict] = total.count;

    let seek:
      | { decidedAt: Date; contentItemId: string; ordinal: number; decisionId: string }
      | undefined;
    if (cursor) {
      const [row] = await db
        .select({
          decidedAt: schema.promptDecisionRevisions.decidedAt,
          decisionId: schema.promptDecisionRevisions.decisionId,
          contentItemId: schema.promptDecisions.contentItemId,
          ordinal: schema.promptDecisions.ordinal,
        })
        .from(schema.promptDecisionRevisions)
        .innerJoin(
          schema.promptDecisions,
          and(
            eq(schema.promptDecisions.id, schema.promptDecisionRevisions.decisionId),
            eq(schema.promptDecisions.orgId, orgId),
          ),
        )
        .where(and(scope, eq(schema.promptDecisionRevisions.decisionId, cursor)))
        .limit(1);
      if (!row) throw new NotFoundException("Decision cursor not found");
      seek = row;
    }
    const page = await db
      .select({
        id: schema.promptDecisions.id,
        contentItemId: schema.promptDecisions.contentItemId,
        liveItemId: schema.contentItems.id,
        verdict: schema.promptDecisions.verdict,
        decidedAt: schema.promptDecisionRevisions.decidedAt,
      })
      .from(schema.promptDecisionRevisions)
      .innerJoin(
        schema.promptDecisions,
        and(
          eq(schema.promptDecisions.id, schema.promptDecisionRevisions.decisionId),
          eq(schema.promptDecisions.orgId, orgId),
        ),
      )
      .leftJoin(
        schema.contentItems,
        and(
          eq(schema.contentItems.id, schema.promptDecisions.contentItemId),
          eq(schema.contentItems.orgId, orgId),
        ),
      )
      .where(
        and(
          scope,
          seek
            ? sql`(${schema.promptDecisionRevisions.decidedAt}, ${schema.promptDecisions.contentItemId}, ${schema.promptDecisions.ordinal}, ${schema.promptDecisionRevisions.decisionId}) < (${seek.decidedAt}, ${seek.contentItemId}, ${seek.ordinal}, ${seek.decisionId})`
            : undefined,
        ),
      )
      .orderBy(
        desc(schema.promptDecisionRevisions.decidedAt),
        // One clock tick can hold several opposite acts on the same draft.
        // Its locked ordinal, not the random UUID, gives them causal order.
        desc(schema.promptDecisions.contentItemId),
        desc(schema.promptDecisions.ordinal),
        desc(schema.promptDecisionRevisions.decisionId),
      )
      .limit(21);
    const visible = page.slice(0, 20);
    return {
      revisionId,
      role,
      days,
      counts,
      rows: visible.map((row) => ({
        id: row.id,
        contentItemId: row.contentItemId,
        itemExists: row.liveItemId !== null,
        verdict: row.verdict,
        decidedAt: row.decidedAt.toISOString(),
      })),
      nextCursor: page.length > 20 ? (visible.at(-1)?.id ?? null) : null,
    };
  }

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
