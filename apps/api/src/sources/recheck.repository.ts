import { Injectable } from "@nestjs/common";
import { DEFAULT_MODELS, estimateCostUsd, priceFor } from "@pubrick/ai";
import { schema } from "@pubrick/db";
import { type NewsRecheckRequest, preferredCredential } from "@pubrick/shared";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { conflict, notFound } from "../api-error";
import { db } from "../db";
import { QueueService } from "../queue/queue.service";

const BATCH_COLUMNS = {
  id: schema.relevanceBatches.id,
  status: schema.relevanceBatches.status,
  days: schema.relevanceBatches.days,
  selectedCount: schema.relevanceBatches.selectedCount,
  processedCount: schema.relevanceBatches.processedCount,
  updatedCount: schema.relevanceBatches.updatedCount,
  failedCount: schema.relevanceBatches.failedCount,
  skippedCount: schema.relevanceBatches.skippedCount,
  unrecordedCalls: schema.relevanceBatches.unrecordedCalls,
  errorCode: schema.relevanceBatches.errorCode,
  createdAt: schema.relevanceBatches.createdAt,
  startedAt: schema.relevanceBatches.startedAt,
  completedAt: schema.relevanceBatches.completedAt,
};

function eligibleStory(orgId: string, brandId: string, days: number) {
  return and(
    eq(schema.newsItems.orgId, orgId),
    eq(schema.newsItems.brandId, brandId),
    eq(schema.newsItems.relevanceStatus, "scored"),
    gte(schema.newsItems.createdAt, sql`now() - (${days} * interval '1 day')`),
  );
}

@Injectable()
export class RecheckRepository {
  constructor(private readonly queue: QueueService) {}

  private async requireBrand(orgId: string, brandId: string) {
    const [brand] = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    if (!brand) throw notFound("brand_not_found", "Brand not found");
  }

  private candidates(orgId: string, brandId: string, days: number, limit: number) {
    return db
      .select({ id: schema.newsItems.id })
      .from(schema.newsItems)
      .where(eligibleStory(orgId, brandId, days))
      .orderBy(desc(schema.newsItems.createdAt), desc(schema.newsItems.id))
      .limit(limit);
  }

  async preview(orgId: string, brandId: string, days: number) {
    await this.requireBrand(orgId, brandId);
    const [rows, credentials] = await Promise.all([
      this.candidates(orgId, brandId, days, 501),
      db
        .select({
          provider: schema.aiCredentials.provider,
          defaultModel: schema.aiCredentials.defaultModel,
          createdAt: schema.aiCredentials.createdAt,
        })
        .from(schema.aiCredentials)
        .where(eq(schema.aiCredentials.orgId, orgId)),
    ]);
    const credential = preferredCredential(credentials);
    const model = credential
      ? (credential.defaultModel ?? DEFAULT_MODELS[credential.provider])
      : null;
    const rate = model && credential ? priceFor(credential.provider, model, new Date()) : null;
    const eligible = Math.min(rows.length, 500);
    return {
      days,
      eligible,
      capped: rows.length > 500,
      maxModelCalls: eligible,
      maxEmbeddingCalls: eligible,
      model,
      // Planning estimate only: 3k input and 500 output tokens per verdict. Embeddings
      // and provider-specific pricing are separate, and actual ledger entries win.
      estimatedCostUsd: rate
        ? estimateCostUsd(rate, { inputTokens: 3000, outputTokens: 500 }) * eligible
        : null,
    };
  }

  async latest(orgId: string, brandId: string) {
    await this.requireBrand(orgId, brandId);
    const [row] = await db
      .select(BATCH_COLUMNS)
      .from(schema.relevanceBatches)
      .where(
        and(eq(schema.relevanceBatches.orgId, orgId), eq(schema.relevanceBatches.brandId, brandId)),
      )
      .orderBy(desc(schema.relevanceBatches.createdAt), desc(schema.relevanceBatches.id))
      .limit(1);
    return { batch: row ?? null };
  }

  async admit(orgId: string, brandId: string, request: NewsRecheckRequest) {
    await this.requireBrand(orgId, brandId);
    try {
      return await db.transaction(async (tx) => {
        // Lock the brand row so two concurrent previews/admissions cannot select
        // overlapping work before the partial unique index rejects the second.
        await tx.execute(
          sql`SELECT id FROM brands WHERE org_id = ${orgId} AND id = ${brandId} FOR UPDATE`,
        );
        const candidates = await tx
          .select({ id: schema.newsItems.id })
          .from(schema.newsItems)
          .where(eligibleStory(orgId, brandId, request.days))
          .orderBy(desc(schema.newsItems.createdAt), desc(schema.newsItems.id))
          .limit(request.maxItems === 500 ? 500 : request.maxItems + 1);
        if (candidates.length === 0)
          throw conflict("recheck_empty", "No recent stories to recheck");
        if (request.maxItems < 500 && candidates.length > request.maxItems)
          throw conflict("recheck_preview_stale", "The preview changed; review the cost again");
        const [batch] = await tx
          .insert(schema.relevanceBatches)
          .values({ orgId, brandId, days: request.days, selectedCount: candidates.length })
          .returning(BATCH_COLUMNS);
        if (!batch) throw new Error("Recheck admission did not create a batch");
        const items = await tx
          .insert(schema.relevanceBatchItems)
          .values(
            candidates.map((candidate) => ({
              orgId,
              brandId,
              batchId: batch.id,
              itemId: candidate.id,
            })),
          )
          .returning({
            id: schema.relevanceBatchItems.id,
            itemId: schema.relevanceBatchItems.itemId,
          });
        for (const item of items) {
          await this.queue.enqueueRelevanceBatch(
            tx,
            { orgId, brandId, batchId: batch.id, itemId: item.itemId },
            item.id,
          );
        }
        return batch;
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "cause" in error &&
        typeof error.cause === "object" &&
        error.cause !== null &&
        "code" in error.cause &&
        error.cause.code === "23505"
      )
        throw conflict("recheck_busy", "A paid recheck is already running for this brand");
      throw error;
    }
  }
}
