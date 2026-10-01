import { isDeepStrictEqual } from "node:util";
import { ForbiddenException, Injectable } from "@nestjs/common";
import { type BillingTransaction, schema } from "@pubrick/db";
import {
  CONTENT_REUSE_DIGEST_VERSION,
  CONTENT_REUSE_ELIGIBLE_STATUSES,
  CONTENT_REUSE_HASH_VERSION,
  type ContentReuseCreate,
  type ContentReuseRetry,
  type ContentReuseSourcePreview,
  contentReuseActorIdSchema,
  contentReuseMaterialSchema,
  contentReuseSourcePreviewSchema,
  MAX_CONTENT_REUSE_OPERATIONS,
  MAX_SOURCE_TEXT_LENGTH,
  normalizeNewlines,
  RUN_ADMISSION_LOCK_NAMESPACE,
  runCreateSchema,
} from "@pubrick/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { badRequest, conflict, gone, notFound } from "../api-error";
import { db } from "../db";
import { currentRequestAuthority } from "../request-authority";
import { authorizeRequestActor } from "../request-authority-admission";
import { RunsRepository } from "../runs/runs.repository";
import { tenantQuotaMode, withQuotaErrors } from "../tenant-quota";
import { hashContentReuseRequest, hashContentReuseSource } from "./content-reuse-hash";

const SOURCE_COLUMNS = {
  id: schema.contentItems.id,
  brandId: schema.contentItems.brandId,
  title: schema.contentItems.title,
  bodyRevision: schema.contentItems.bodyRevision,
  body: schema.contentItems.body,
  status: schema.contentItems.status,
  origin: schema.contentItems.origin,
};
type Source = { [K in keyof typeof SOURCE_COLUMNS]: (typeof schema.contentItems.$inferSelect)[K] };

@Injectable()
export class ContentReuseRepository {
  constructor(private readonly runs: RunsRepository) {}

  private preview(source: Source): ContentReuseSourcePreview {
    if (!(CONTENT_REUSE_ELIGIBLE_STATUSES as readonly string[]).includes(source.status))
      throw conflict("reuse_source_ineligible", "This saved content cannot currently be reused");
    const material = normalizeNewlines(source.body);
    if (material.length > MAX_SOURCE_TEXT_LENGTH)
      throw badRequest(
        "reuse_source_too_long",
        `The saved source has ${material.length} characters; the limit is ${MAX_SOURCE_TEXT_LENGTH}`,
      );
    const parsed = contentReuseMaterialSchema.safeParse(material);
    if (!parsed.success)
      throw badRequest("invalid_request", "The saved source must contain valid nonblank text");
    return contentReuseSourcePreviewSchema.parse({
      id: source.id,
      brandId: source.brandId,
      title: source.title,
      bodyRevision: source.bodyRevision,
      material: parsed.data,
      status: source.status,
      origin: source.origin,
      digest: hashContentReuseSource({
        version: CONTENT_REUSE_DIGEST_VERSION,
        contentId: source.id,
        brandId: source.brandId,
        title: source.title,
        bodyRevision: source.bodyRevision,
        material: parsed.data,
      }),
    });
  }

  async source(orgId: string, id: string) {
    const [source] = await db
      .select(SOURCE_COLUMNS)
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)));
    if (!source) throw notFound("content_not_found", "Content not found");
    return this.preview(source);
  }

  async create(orgId: string, sourceId: string, key: string, data: ContentReuseCreate) {
    sourceId = sourceId.toLowerCase();
    const actor = currentRequestAuthority();
    if (
      actor?.kind !== "session" ||
      actor.orgId !== orgId ||
      actor.sessionOperation?.operation !== "reuse" ||
      actor.sessionOperation.key !== key ||
      actor.resourceId !== sourceId
    )
      throw new ForbiddenException("A verified author session reuse operation is required");
    const userId = contentReuseActorIdSchema.parse(actor.userId);
    const requestHash = hashContentReuseRequest("reuse", sourceId, data);
    return withQuotaErrors(() =>
      db.transaction(async (tx) => {
        await this.authorize(tx, orgId);
        const replay = await this.replay(tx, orgId, "reuse", sourceId, key, requestHash);
        if (replay) return replay;
        await this.capacity(tx, orgId);
        const [source] = await tx
          .select(SOURCE_COLUMNS)
          .from(schema.contentItems)
          .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, sourceId)));
        if (!source) throw notFound("content_not_found", "Content not found");
        const prepared = this.preview(source);
        this.compare(prepared, data);
        const id = await this.runs.createInTx(
          tx,
          orgId,
          runCreateSchema.parse({
            brandId: prepared.brandId,
            channelIds: data.channelIds,
            contentType: data.contentType,
            material: prepared.material,
            title: data.title,
            brief: data.brief,
          }),
          { ...tenantQuotaMode(), authorizeActor: authorizeRequestActor },
          async (callbackTx, input) => {
            await this.lockBrandChannels(callbackTx, orgId, prepared.brandId, data.channelIds);
            const [locked] = await callbackTx
              .select(SOURCE_COLUMNS)
              .from(schema.contentItems)
              .where(
                and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, sourceId)),
              )
              .for("share");
            if (!locked || locked.brandId !== prepared.brandId)
              throw conflict(
                "reuse_source_changed",
                "The saved source changed; reload its preview",
              );
            const current = this.preview(locked);
            this.compare(current, data);
            if (
              current.material !== prepared.material ||
              current.title !== prepared.title ||
              input.material !== prepared.material ||
              input.title !== data.title ||
              input.brief !== (data.brief?.trim() ? data.brief : null) ||
              input.channelIds.join(",") !== data.channelIds.join(",")
            )
              throw conflict(
                "reuse_source_changed",
                "The saved source changed; reload its preview",
              );
            return {
              sourceAttribution: {
                sourceContentId: prepared.id,
                sourceRevision: prepared.bodyRevision,
                sourceTitle: prepared.title,
                sourceDigest: prepared.digest,
                sourceOrigin: prepared.origin,
                acceptedAt: new Date(),
              },
            };
          },
        );
        await tx.insert(schema.contentReuseOperations).values({
          orgId,
          brandId: prepared.brandId,
          operation: "reuse",
          idempotencyKey: key,
          requestHash,
          hashVersion: CONTENT_REUSE_HASH_VERSION,
          rootSourceId: sourceId,
          rootSourceRevision: prepared.bodyRevision,
          requestTargetKind: "content",
          requestTargetId: sourceId,
          resultRunId: id,
          consentingActorId: userId,
          consentVersion: data.consentVersion,
        });
        return { id, status: "queued" as const };
      }),
    );
  }

  async retry(orgId: string, originalId: string, key: string, data: ContentReuseRetry) {
    originalId = originalId.toLowerCase();
    const actor = currentRequestAuthority();
    if (
      actor?.kind !== "session" ||
      actor.orgId !== orgId ||
      actor.sessionOperation?.operation !== "reuse-retry" ||
      actor.sessionOperation.key !== key ||
      actor.resourceId !== originalId
    )
      throw new ForbiddenException("A verified author session retry operation is required");
    const userId = contentReuseActorIdSchema.parse(actor.userId);
    const requestHash = hashContentReuseRequest("reuse-retry", originalId, data);
    return withQuotaErrors(() =>
      db.transaction(async (tx) => {
        await this.authorize(tx, orgId);
        const replay = await this.replay(tx, orgId, "reuse-retry", originalId, key, requestHash);
        if (replay) return replay;
        await this.capacity(tx, orgId);
        const prepared = await this.runs.prepareReuseRetryInTx(tx, orgId, originalId);
        const id = await this.runs.createInTx(
          tx,
          orgId,
          prepared.data,
          { ...tenantQuotaMode(), authorizeActor: authorizeRequestActor },
          async (callbackTx, input) => {
            await this.lockBrandChannels(
              callbackTx,
              orgId,
              prepared.data.brandId,
              prepared.data.channelIds,
            );
            const [original] = await callbackTx
              .select({ id: schema.pipelineRuns.id })
              .from(schema.pipelineRuns)
              .where(
                and(
                  eq(schema.pipelineRuns.orgId, orgId),
                  eq(schema.pipelineRuns.brandId, prepared.data.brandId),
                  eq(schema.pipelineRuns.id, originalId),
                ),
              )
              .for("share");
            if (!original) throw notFound("run_not_found", "Run not found");
            await callbackTx
              .select({ id: schema.runSourceLineage.derivedRunId })
              .from(schema.runSourceLineage)
              .where(
                and(
                  eq(schema.runSourceLineage.orgId, orgId),
                  eq(schema.runSourceLineage.brandId, prepared.data.brandId),
                  eq(schema.runSourceLineage.derivedRunId, originalId),
                ),
              )
              .for("share");
            const current = await this.runs.prepareReuseRetryInTx(callbackTx, orgId, originalId);
            if (
              !isDeepStrictEqual(current, prepared) ||
              input.material !== prepared.data.material ||
              input.title !== prepared.data.title ||
              input.brief !== (prepared.data.brief?.trim() ? prepared.data.brief : null) ||
              input.channelIds.join(",") !== prepared.data.channelIds.join(",")
            )
              throw conflict(
                "run_redacted",
                "The original reuse run changed; reload before retrying",
              );
            return {
              topicId: prepared.topicId,
              sourceAttribution: {
                sourceContentId: prepared.lineage.sourceContentId,
                sourceRevision: prepared.lineage.sourceRevision,
                sourceTitle: prepared.lineage.sourceTitle,
                sourceDigest: prepared.lineage.sourceDigest,
                sourceOrigin: prepared.lineage.sourceOrigin,
                acceptedAt: new Date(),
              },
            };
          },
        );
        await tx.insert(schema.contentReuseOperations).values({
          orgId,
          brandId: prepared.data.brandId,
          operation: "reuse-retry",
          idempotencyKey: key,
          requestHash,
          hashVersion: CONTENT_REUSE_HASH_VERSION,
          rootSourceId: prepared.lineage.sourceContentId,
          rootSourceRevision: prepared.lineage.sourceRevision,
          requestTargetKind: "run",
          requestTargetId: originalId,
          resultRunId: id,
          consentingActorId: userId,
          consentVersion: data.consentVersion,
        });
        return { id, status: "queued" as const };
      }),
    );
  }

  private compare(source: ContentReuseSourcePreview, data: ContentReuseCreate) {
    if (
      source.bodyRevision !== data.expectedSourceRevision ||
      source.digest !== data.expectedSourceDigest
    )
      throw conflict("reuse_source_changed", "The saved source changed; reload its preview");
  }

  private async authorize(tx: BillingTransaction, orgId: string) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${RUN_ADMISSION_LOCK_NAMESPACE},hashtext(${orgId}))`,
    );
    const [org] = await tx
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.id, orgId))
      .for("share");
    if (!org || !(await authorizeRequestActor(tx, orgId)))
      throw new ForbiddenException("Workspace authority changed; sign in and retry");
  }

  private async capacity(tx: BillingTransaction, orgId: string) {
    const [count] = await tx
      .select({ n: sql<string>`count(*)::text` })
      .from(schema.contentReuseOperations)
      .where(eq(schema.contentReuseOperations.orgId, orgId));
    if (BigInt(count?.n ?? "0") >= BigInt(MAX_CONTENT_REUSE_OPERATIONS))
      throw conflict(
        "reuse_operation_limit",
        "The workspace has reached its reuse operation limit",
      );
  }

  private async replay(
    tx: BillingTransaction,
    orgId: string,
    operation: "reuse" | "reuse-retry",
    targetId: string,
    key: string,
    hash: string,
  ) {
    const [previous] = await tx
      .select({
        id: schema.contentReuseOperations.resultRunId,
        hash: schema.contentReuseOperations.requestHash,
        version: schema.contentReuseOperations.hashVersion,
        target: schema.contentReuseOperations.requestTargetId,
        kind: schema.contentReuseOperations.requestTargetKind,
        brandId: schema.contentReuseOperations.brandId,
      })
      .from(schema.contentReuseOperations)
      .where(
        and(
          eq(schema.contentReuseOperations.orgId, orgId),
          eq(schema.contentReuseOperations.operation, operation),
          eq(schema.contentReuseOperations.idempotencyKey, key),
        ),
      );
    if (!previous) return null;
    if (
      previous.hash !== hash ||
      previous.version !== CONTENT_REUSE_HASH_VERSION ||
      previous.target !== targetId ||
      previous.kind !== (operation === "reuse" ? "content" : "run")
    )
      throw conflict("idempotency_conflict", "The operation key belongs to a different request");
    const [result] = await tx
      .select({ id: schema.pipelineRuns.id })
      .from(schema.pipelineRuns)
      .where(
        and(
          eq(schema.pipelineRuns.orgId, orgId),
          eq(schema.pipelineRuns.brandId, previous.brandId),
          eq(schema.pipelineRuns.id, previous.id),
        ),
      );
    if (!result) throw gone("public_result_gone", "The admitted result run no longer exists");
    return { id: previous.id, status: "queued" as const };
  }

  private async lockBrandChannels(
    tx: BillingTransaction,
    orgId: string,
    brandId: string,
    channelIds: readonly string[],
  ) {
    const [brand] = await tx
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .for("no key update");
    if (!brand) throw notFound("brand_not_found", "Brand not found");
    const channels = await tx
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.orgId, orgId),
          eq(schema.channels.brandId, brandId),
          inArray(schema.channels.id, [...channelIds]),
        ),
      )
      .orderBy(asc(schema.channels.id))
      .for("key share");
    if (channels.length !== channelIds.length)
      throw notFound("channels_not_in_brand", "One or more channels do not belong to this brand");
  }
}
