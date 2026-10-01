import { HttpException, Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import {
  PAID_GENERATION_CONSENT_VERSION,
  PUBLIC_REQUEST_HASH_VERSION,
  type PublicDraftCreate,
  type PublicRunCreate,
  type PublicWriteOperation,
  publicRunStatusSchema,
  RUN_ADMISSION_LOCK_NAMESPACE,
} from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
import { ContentRepository } from "../content/content.repository";
import { db } from "../db";
import { env } from "../env";
import { currentRequestAuthority } from "../request-authority";
import { authorizeRequestActor } from "../request-authority-admission";
import { RunsRepository } from "../runs/runs.repository";
import { tenantQuotaMode, withQuotaErrors } from "../tenant-quota";
import { publicRequestHash } from "./public-request-hash";

function fail(status: number, code: string): never {
  throw new HttpException({ code, message: code }, status);
}
@Injectable()
export class PublicWriteRepository {
  constructor(
    private readonly content: ContentRepository,
    private readonly runs: RunsRepository,
  ) {}
  createDraft(orgId: string, key: string, data: PublicDraftCreate) {
    return this.create(orgId, "content:create", key, data);
  }
  createRun(orgId: string, key: string, data: PublicRunCreate) {
    return this.create(orgId, "generation:create", key, data);
  }
  private async create(
    orgId: string,
    operation: PublicWriteOperation,
    key: string,
    data: PublicDraftCreate | PublicRunCreate,
  ) {
    const actor = currentRequestAuthority();
    if (
      actor?.kind !== "api-key" ||
      actor.orgId !== orgId ||
      actor.operation !== operation ||
      actor.scope !== operation
    )
      fail(403, "public_authority_revoked");
    const requestHash = publicRequestHash(operation, data);
    try {
      return await withQuotaErrors(() =>
        db.transaction(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(${RUN_ADMISSION_LOCK_NAMESPACE},hashtext(${orgId}))`,
          );
          const [org] = await tx
            .select({ id: schema.organization.id })
            .from(schema.organization)
            .where(eq(schema.organization.id, orgId))
            .for("share");
          if (!org) fail(403, "public_authority_revoked");
          const expected = { operation, brandId: data.brandId, channelIds: data.channelIds };
          if (!(await authorizeRequestActor(tx, orgId, expected)))
            fail(403, "public_authority_revoked");
          const [previous] = await tx
            .select({
              resultId: schema.publicApiOperations.resultId,
              requestHash: schema.publicApiOperations.requestHash,
              hashVersion: schema.publicApiOperations.hashVersion,
            })
            .from(schema.publicApiOperations)
            .where(
              and(
                eq(schema.publicApiOperations.orgId, orgId),
                eq(schema.publicApiOperations.operation, operation),
                eq(schema.publicApiOperations.idempotencyKey, key),
              ),
            );
          if (previous) {
            if (
              previous.requestHash !== requestHash ||
              previous.hashVersion !== PUBLIC_REQUEST_HASH_VERSION
            )
              fail(409, "idempotency_conflict");
            const table =
              operation === "content:create" ? schema.contentItems : schema.pipelineRuns;
            const [result] = await tx
              .select({ id: table.id })
              .from(table)
              .where(and(eq(table.orgId, orgId), eq(table.id, previous.resultId)));
            if (!result) fail(410, "public_result_gone");
            return this.ack(operation, previous.resultId);
          }
          const [count] = await tx
            .select({ n: sql<string>`count(*)::text` })
            .from(schema.publicApiOperations)
            .where(eq(schema.publicApiOperations.orgId, orgId));
          if (BigInt(count?.n ?? "0") >= BigInt(env.PUBLIC_API_MAX_OPERATION_RECORDS))
            fail(409, "public_operation_capacity");
          const mode = {
            ...tenantQuotaMode(),
            authorizeActor: (
              targetTx: Parameters<typeof authorizeRequestActor>[0],
              targetOrg: string,
            ) => authorizeRequestActor(targetTx, targetOrg, expected),
          };
          const id =
            operation === "content:create"
              ? await this.content.createInTx(tx, orgId, data as PublicDraftCreate, true)
              : await this.runs.createInTx(
                  tx,
                  orgId,
                  data as PublicRunCreate,
                  mode,
                  undefined,
                  expected,
                );
          await tx.insert(schema.publicApiOperations).values({
            orgId,
            operation,
            keyId: actor.keyId,
            idempotencyKey: key,
            requestHash,
            hashVersion: PUBLIC_REQUEST_HASH_VERSION,
            resultId: id,
            consentVersion:
              operation === "generation:create" ? PAID_GENERATION_CONSENT_VERSION : null,
          });
          return this.ack(operation, id);
        }),
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;
      fail(503, "public_request_unavailable");
    }
  }
  private ack(operation: PublicWriteOperation, id: string) {
    return operation === "content:create"
      ? { id, status: "draft" as const, origin: "external" as const, requiresReview: true as const }
      : { id, status: "queued" as const };
  }
  async status(orgId: string, id: string) {
    const [run] = await db
      .select({
        id: schema.pipelineRuns.id,
        status: schema.pipelineRuns.status,
        contentItemId: schema.pipelineRuns.contentItemId,
        unrecordedCalls: schema.pipelineRuns.unrecordedCalls,
      })
      .from(schema.pipelineRuns)
      .where(and(eq(schema.pipelineRuns.orgId, orgId), eq(schema.pipelineRuns.id, id)));
    if (!run) fail(404, "run_not_found");
    const [usage] = await db
      .select({
        calls: sql<string>`count(*)::text`,
        unpriced: sql<string>`count(*) filter(where ${schema.usageLedger.costUsd} is null or ${schema.usageLedger.costSource} = 'unknown')::text`,
        total: sql<string>`coalesce(sum(${schema.usageLedger.costUsd}),0)::text`,
      })
      .from(schema.usageLedger)
      .where(and(eq(schema.usageLedger.orgId, orgId), eq(schema.usageLedger.runId, id)));
    const cost =
      !usage || usage.calls === "0" || usage.unpriced !== "0" || run.unrecordedCalls !== 0
        ? { status: "unknown" as const }
        : { status: "known" as const, amountUsd: usage.total };
    return publicRunStatusSchema.parse({
      id: run.id,
      status: run.status,
      contentItemId: run.contentItemId,
      error:
        run.status === "failed"
          ? "generation_failed"
          : run.status === "cancelled"
            ? "cancelled"
            : null,
      cost,
    });
  }
}
