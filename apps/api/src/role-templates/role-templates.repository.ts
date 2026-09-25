import { createHash } from "node:crypto";
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  builtInRoleTemplateSource,
  previewRoleTemplate,
  previewRoleTemplateInstruction,
  RoleTemplateError,
  validateTemplateSnapshot,
} from "@pubrick/ai";
import { schema } from "@pubrick/db";
import {
  CONTENT_STATUSES,
  PROMPT_ROLES,
  type PromptRole,
  type RoleTemplateActivation,
  type RoleTemplateHeadDto,
  type RoleTemplateHistoryDto,
  type RoleTemplateOutcomeComparisonDto,
  type RoleTemplateOutcomeRowDto,
  type RoleTemplatePreviewDto,
  type RoleTemplateRevisionDto,
} from "@pubrick/shared";
import { and, asc, desc, eq, exists, inArray, isNotNull, lt, or, sql } from "drizzle-orm";
import { badRequest } from "../api-error";
import { db } from "../db";

const REVISION_COLUMNS = {
  id: schema.roleTemplateRevisions.id,
  role: schema.roleTemplateRevisions.role,
  version: schema.roleTemplateRevisions.version,
  source: schema.roleTemplateRevisions.source,
  sourceSha256: schema.roleTemplateRevisions.sourceSha256,
  createdAt: schema.roleTemplateRevisions.createdAt,
};

function revisionDto(row: {
  id: string;
  role: PromptRole;
  version: number;
  source: string;
  sourceSha256: string;
  createdAt: Date;
}): RoleTemplateRevisionDto {
  return { ...row, createdAt: row.createdAt.toISOString() };
}

function validatedPreview(role: PromptRole, source: string) {
  try {
    const rendered = previewRoleTemplate(role, source);
    const { instructionBytes } = previewRoleTemplateInstruction(role, source);
    return { rendered, instructionBytes };
  } catch (error) {
    if (error instanceof RoleTemplateError) {
      const location = error.position === undefined ? "" : ` at position ${error.position}`;
      throw badRequest("invalid_request", `source: ${error.message}${location}`);
    }
    throw error;
  }
}

function headDto(
  role: PromptRole,
  head: { activeRevisionId: string | null; generation: number } | undefined,
  activeVersion: number | null,
): RoleTemplateHeadDto {
  return {
    role,
    activeRevisionId: head?.activeRevisionId ?? null,
    activeVersion,
    generation: head?.generation ?? 0,
    builtInSource: builtInRoleTemplateSource(role),
  };
}

function emptyOutcome(
  selection:
    | { kind: "default"; revisionId: null; version: null }
    | {
        kind: "revision";
        revisionId: string;
        version: number;
      },
): RoleTemplateOutcomeRowDto {
  return {
    ...selection,
    runCount: 0,
    succeededRuns: 0,
    publishedRuns: 0,
    currentItemStatuses: Object.fromEntries(
      CONTENT_STATUSES.map((status) => [status, 0]),
    ) as RoleTemplateOutcomeRowDto["currentItemStatuses"],
    withoutCurrentItem: 0,
    reviewActs: { approved: 0, rejected: 0 },
  };
}

@Injectable()
export class RoleTemplatesRepository {
  /** Source text is manager-only: the controller guards even read-only routes. */
  async list(orgId: string): Promise<RoleTemplateHeadDto[]> {
    const heads = await db
      .select({
        role: schema.roleTemplateHeads.role,
        activeRevisionId: schema.roleTemplateHeads.activeRevisionId,
        generation: schema.roleTemplateHeads.generation,
        activeVersion: schema.roleTemplateRevisions.version,
      })
      .from(schema.roleTemplateHeads)
      .leftJoin(
        schema.roleTemplateRevisions,
        and(
          eq(schema.roleTemplateRevisions.orgId, orgId),
          eq(schema.roleTemplateRevisions.role, schema.roleTemplateHeads.role),
          eq(schema.roleTemplateRevisions.id, schema.roleTemplateHeads.activeRevisionId),
        ),
      )
      .where(eq(schema.roleTemplateHeads.orgId, orgId));
    const byRole = new Map(heads.map((row) => [row.role, row]));
    return PROMPT_ROLES.map((role) => {
      const row = byRole.get(role);
      return headDto(role, row, row?.activeVersion ?? null);
    });
  }

  async history(orgId: string, role: PromptRole, cursor?: number): Promise<RoleTemplateHistoryDto> {
    const rows = await db
      .select(REVISION_COLUMNS)
      .from(schema.roleTemplateRevisions)
      .where(
        and(
          eq(schema.roleTemplateRevisions.orgId, orgId),
          eq(schema.roleTemplateRevisions.role, role),
          cursor === undefined ? undefined : lt(schema.roleTemplateRevisions.version, cursor),
        ),
      )
      .orderBy(desc(schema.roleTemplateRevisions.version))
      .limit(101);
    const visible = rows.slice(0, 100);
    return {
      rows: visible.map(revisionDto),
      nextCursor: rows.length > 100 ? (visible.at(-1)?.version ?? null) : null,
    };
  }

  /** Observations are grouped by the role source frozen on first run claim. */
  async outcomes(
    orgId: string,
    brandId: string,
    role: PromptRole,
    days: 7 | 30 | 90,
    cursor?: number,
  ): Promise<RoleTemplateOutcomeComparisonDto> {
    const [brand] = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    if (!brand) throw new NotFoundException("Brand not found");
    const [head] = await db
      .select({ activeRevisionId: schema.roleTemplateHeads.activeRevisionId })
      .from(schema.roleTemplateHeads)
      .where(
        and(eq(schema.roleTemplateHeads.orgId, orgId), eq(schema.roleTemplateHeads.role, role)),
      )
      .limit(1);
    const revisions = await db
      .select({
        id: schema.roleTemplateRevisions.id,
        version: schema.roleTemplateRevisions.version,
        sourceSha256: schema.roleTemplateRevisions.sourceSha256,
      })
      .from(schema.roleTemplateRevisions)
      .where(
        and(
          eq(schema.roleTemplateRevisions.orgId, orgId),
          eq(schema.roleTemplateRevisions.role, role),
          cursor === undefined ? undefined : lt(schema.roleTemplateRevisions.version, cursor),
        ),
      )
      .orderBy(desc(schema.roleTemplateRevisions.version))
      .limit(101);
    const visible = revisions.slice(0, 100);
    const defaultRow = emptyOutcome({ kind: "default", revisionId: null, version: null });
    const rows = visible.map((revision) =>
      emptyOutcome({ kind: "revision", revisionId: revision.id, version: revision.version }),
    );
    await this.fillOutcomes(orgId, brandId, role, days, defaultRow, rows, visible);
    return {
      brandId,
      role,
      days,
      activeRevisionId: head?.activeRevisionId ?? null,
      default: defaultRow,
      rows,
      nextCursor: revisions.length > 100 ? (visible.at(-1)?.version ?? null) : null,
    };
  }

  async usage(
    orgId: string,
    brandId: string,
    role: PromptRole,
    revisionId: string,
    days: 7 | 30 | 90,
  ): Promise<RoleTemplateOutcomeRowDto> {
    const [brand] = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    if (!brand) throw new NotFoundException("Brand not found");
    const [revision] = await db
      .select({
        id: schema.roleTemplateRevisions.id,
        version: schema.roleTemplateRevisions.version,
        sourceSha256: schema.roleTemplateRevisions.sourceSha256,
      })
      .from(schema.roleTemplateRevisions)
      .where(
        and(
          eq(schema.roleTemplateRevisions.orgId, orgId),
          eq(schema.roleTemplateRevisions.role, role),
          eq(schema.roleTemplateRevisions.id, revisionId),
        ),
      )
      .limit(1);
    if (!revision) throw new NotFoundException("Role template revision not found");
    const row = emptyOutcome({
      kind: "revision",
      revisionId: revision.id,
      version: revision.version,
    });
    await this.fillOutcomes(orgId, brandId, role, days, null, [row], [revision]);
    return row;
  }

  private async fillOutcomes(
    orgId: string,
    brandId: string,
    role: PromptRole,
    days: 7 | 30 | 90,
    defaultRow: RoleTemplateOutcomeRowDto | null,
    rows: RoleTemplateOutcomeRowDto[],
    revisions: { id: string; version: number; sourceSha256: string }[],
  ): Promise<void> {
    const byId = new Map(rows.map((row) => [row.revisionId, row]));
    const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));
    const roleKind = sql<string>`jsonb_extract_path_text(${schema.pipelineRuns.templateSnapshot}, 'roles', ${role}, 'kind')`;
    const roleRevisionId = sql<string>`jsonb_extract_path_text(${schema.pipelineRuns.templateSnapshot}, 'roles', ${role}, 'revisionId')`;
    const eligible = or(
      defaultRow ? eq(roleKind, "default") : undefined,
      revisions.length
        ? inArray(
            roleRevisionId,
            revisions.map((revision) => revision.id),
          )
        : undefined,
    );
    const window = sql`${schema.pipelineRuns.createdAt} >= now()::timestamp - (${days} * interval '1 day')`;
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
            eq(schema.adaptations.contentItemId, schema.pipelineRuns.contentItemId),
          ),
        ),
    );
    let afterId: string | undefined;
    for (;;) {
      const page = await db
        .select({
          id: schema.pipelineRuns.id,
          runStatus: schema.pipelineRuns.status,
          templateSnapshot: schema.pipelineRuns.templateSnapshot,
          itemStatus: schema.contentItems.status,
          hasReceipt,
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
        .where(
          and(
            eq(schema.pipelineRuns.orgId, orgId),
            eq(schema.pipelineRuns.brandId, brandId),
            window,
            isNotNull(schema.pipelineRuns.templateSnapshot),
            eligible,
            afterId
              ? sql`(${schema.pipelineRuns.createdAt}, ${schema.pipelineRuns.id}) >
                  (SELECT cursor_run.created_at, cursor_run.id FROM pipeline_runs AS cursor_run
                   WHERE cursor_run.id = ${afterId}::uuid AND cursor_run.org_id = ${orgId})`
              : undefined,
          ),
        )
        .orderBy(asc(schema.pipelineRuns.createdAt), asc(schema.pipelineRuns.id))
        .limit(500);
      for (const run of page) {
        if (!run.templateSnapshot) continue;
        let pinned: ReturnType<typeof validateTemplateSnapshot>;
        try {
          pinned = validateTemplateSnapshot(run.templateSnapshot);
        } catch {
          continue;
        }
        const selected = pinned.roles[role];
        const row = selected.kind === "default" ? defaultRow : byId.get(selected.revisionId);
        if (!row) continue;
        if (selected.kind === "revision") {
          const revision = revisionById.get(selected.revisionId);
          if (
            !revision ||
            revision.version !== selected.version ||
            revision.sourceSha256 !== selected.sourceSha256
          )
            continue;
        }
        row.runCount++;
        if (run.runStatus === "succeeded") row.succeededRuns++;
        if (run.hasReceipt) row.publishedRuns++;
        if (run.itemStatus) row.currentItemStatuses[run.itemStatus]++;
        else row.withoutCurrentItem++;
      }
      if (page.length < 500) break;
      afterId = page.at(-1)?.id;
    }

    // Decision links were independently verified at the human act, and may
    // survive later edits or deletion of the current draft.
    const acts = await db
      .select({
        revisionId: schema.promptDecisionTemplateRevisions.revisionId,
        version: schema.promptDecisionTemplateRevisions.version,
        isDefault: schema.promptDecisionTemplateRevisions.isDefault,
        verdict: schema.promptDecisions.verdict,
        count: sql<number>`count(*)::int`,
      })
      .from(schema.promptDecisionTemplateRevisions)
      .innerJoin(
        schema.promptDecisions,
        and(
          eq(schema.promptDecisions.id, schema.promptDecisionTemplateRevisions.decisionId),
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
          eq(schema.promptDecisionTemplateRevisions.orgId, orgId),
          eq(schema.promptDecisionTemplateRevisions.role, role),
          eq(schema.pipelineRuns.brandId, brandId),
          window,
        ),
      )
      .groupBy(
        schema.promptDecisionTemplateRevisions.revisionId,
        schema.promptDecisionTemplateRevisions.version,
        schema.promptDecisionTemplateRevisions.isDefault,
        schema.promptDecisions.verdict,
      );
    for (const act of acts) {
      const row = act.isDefault ? defaultRow : byId.get(act.revisionId);
      if (!row) continue;
      if (!act.isDefault && row.version !== act.version) continue;
      row.reviewActs[act.verdict] += act.count;
    }
  }

  async revision(
    orgId: string,
    role: PromptRole,
    revisionId: string,
  ): Promise<RoleTemplateRevisionDto> {
    const [row] = await db
      .select(REVISION_COLUMNS)
      .from(schema.roleTemplateRevisions)
      .where(
        and(
          eq(schema.roleTemplateRevisions.orgId, orgId),
          eq(schema.roleTemplateRevisions.role, role),
          eq(schema.roleTemplateRevisions.id, revisionId),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException("Role template revision not found");
    return revisionDto(row);
  }

  preview(_orgId: string, role: PromptRole, source: string): RoleTemplatePreviewDto {
    const { rendered, instructionBytes } = validatedPreview(role, source);
    return {
      source: rendered.source,
      renderedBody: rendered.text,
      variables: rendered.variables,
      renderedBodyBytes: Buffer.byteLength(rendered.text, "utf8"),
      sampleInstructionBytes: instructionBytes,
    };
  }

  async append(
    orgId: string,
    role: PromptRole,
    source: string,
    userId: string,
  ): Promise<RoleTemplateRevisionDto> {
    const { rendered: validated } = validatedPreview(role, source);
    const sourceSha256 = createHash("sha256").update(validated.source).digest("hex");
    return db.transaction(async (tx) => {
      // This lock serializes version allocation with activation and first claim.
      const [org] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, orgId))
        .for("update");
      if (!org) throw new NotFoundException("Organization not found");
      const [current] = await tx
        .select({ version: schema.roleTemplateRevisions.version })
        .from(schema.roleTemplateRevisions)
        .where(
          and(
            eq(schema.roleTemplateRevisions.orgId, orgId),
            eq(schema.roleTemplateRevisions.role, role),
          ),
        )
        .orderBy(desc(schema.roleTemplateRevisions.version))
        .limit(1);
      await tx.insert(schema.roleTemplateHeads).values({ orgId, role }).onConflictDoNothing();
      const [created] = await tx
        .insert(schema.roleTemplateRevisions)
        .values({
          orgId,
          role,
          version: (current?.version ?? 0) + 1,
          source: validated.source,
          sourceSha256,
          createdBy: userId,
        })
        .returning(REVISION_COLUMNS);
      if (!created) throw new Error("Role template insert returned no row");
      return revisionDto(created);
    });
  }

  async activate(
    orgId: string,
    role: PromptRole,
    request: RoleTemplateActivation,
  ): Promise<RoleTemplateHeadDto> {
    return db.transaction(async (tx) => {
      const [org] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, orgId))
        .for("update");
      if (!org) throw new NotFoundException("Organization not found");
      const [gate] = await tx
        .select({ activationEnabled: schema.roleTemplateActivationGate.activationEnabled })
        .from(schema.roleTemplateActivationGate)
        .where(eq(schema.roleTemplateActivationGate.id, 1))
        .limit(1);
      if (!gate?.activationEnabled) {
        throw new ConflictException(
          "Role template activation is unavailable until worker rollout completes",
        );
      }
      await tx.insert(schema.roleTemplateHeads).values({ orgId, role }).onConflictDoNothing();
      const [current] = await tx
        .select({
          activeRevisionId: schema.roleTemplateHeads.activeRevisionId,
          generation: schema.roleTemplateHeads.generation,
        })
        .from(schema.roleTemplateHeads)
        .where(
          and(eq(schema.roleTemplateHeads.orgId, orgId), eq(schema.roleTemplateHeads.role, role)),
        )
        .for("update");
      if (!current) throw new Error("Role template head insert returned no row");
      if (
        current.activeRevisionId !== request.expectedRevisionId ||
        current.generation !== request.expectedGeneration
      ) {
        const [active] = current.activeRevisionId
          ? await tx
              .select({ version: schema.roleTemplateRevisions.version })
              .from(schema.roleTemplateRevisions)
              .where(
                and(
                  eq(schema.roleTemplateRevisions.orgId, orgId),
                  eq(schema.roleTemplateRevisions.role, role),
                  eq(schema.roleTemplateRevisions.id, current.activeRevisionId),
                ),
              )
              .limit(1)
          : [];
        throw new ConflictException({
          statusCode: 409,
          message: "Role template head changed; review its current revision before activating",
          head: headDto(role, current, active?.version ?? null),
        });
      }
      let targetVersion: number | null = null;
      if (request.revisionId) {
        const [target] = await tx
          .select({ version: schema.roleTemplateRevisions.version })
          .from(schema.roleTemplateRevisions)
          .where(
            and(
              eq(schema.roleTemplateRevisions.orgId, orgId),
              eq(schema.roleTemplateRevisions.role, role),
              eq(schema.roleTemplateRevisions.id, request.revisionId),
            ),
          )
          .limit(1);
        if (!target) throw new NotFoundException("Role template revision not found");
        targetVersion = target.version;
      }
      if (current.activeRevisionId === request.revisionId) {
        return headDto(role, current, targetVersion);
      }
      const [updated] = await tx
        .update(schema.roleTemplateHeads)
        .set({ activeRevisionId: request.revisionId, generation: current.generation + 1 })
        .where(
          and(eq(schema.roleTemplateHeads.orgId, orgId), eq(schema.roleTemplateHeads.role, role)),
        )
        .returning({
          activeRevisionId: schema.roleTemplateHeads.activeRevisionId,
          generation: schema.roleTemplateHeads.generation,
        });
      if (!updated) throw new Error("Role template head update returned no row");
      return headDto(role, updated, targetVersion);
    });
  }
}
