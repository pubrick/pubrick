import { createHash } from "node:crypto";
import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import {
  builtInRoleTemplateSource,
  previewRoleTemplate,
  previewRoleTemplateInstruction,
  RoleTemplateError,
} from "@pubrick/ai";
import { schema } from "@pubrick/db";
import {
  PROMPT_ROLES,
  type PromptRole,
  type RoleTemplateActivation,
  type RoleTemplateHeadDto,
  type RoleTemplateHistoryDto,
  type RoleTemplatePreviewDto,
  type RoleTemplateRevisionDto,
} from "@pubrick/shared";
import { and, desc, eq, lt } from "drizzle-orm";
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
