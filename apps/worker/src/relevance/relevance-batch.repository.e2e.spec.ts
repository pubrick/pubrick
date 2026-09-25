import { KNOWLEDGE_EMBEDDING_DIMENSIONS, KNOWLEDGE_EMBEDDING_MODEL } from "@pubrick/ai";
import { schema } from "@pubrick/db";
import { and, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("paid relevance batch progress (Postgres)", () => {
  let repo: InstanceType<typeof import("./relevance.repository").RelevanceRepository>;
  let db: Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["db"];
  let pool: Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["pool"];
  let boss: PgBoss;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const { createDb } = await import("@pubrick/db");
    ({ db, pool } = createDb(url as string));
    boss = new PgBoss(url as string);
    await boss.start();
    const { RelevanceRepository } = await import("./relevance.repository");
    repo = new RelevanceRepository();
  });
  afterAll(async () => {
    await boss.stop();
    await pool.end();
    await (await import("../db")).pool.end();
  });

  it("preserves failed old verdicts, advances exactly once, and stops on terminal auth failure", async () => {
    const orgId = `bulk-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await db
      .insert(schema.organization)
      .values({ id: orgId, name: "Bulk", slug: orgId, createdAt: new Date() });
    const [brand] = await db
      .insert(schema.brands)
      .values({ orgId, name: "Cafe" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("brand fixture");
    const [source] = await db
      .insert(schema.newsSources)
      .values({ orgId, brandId: brand.id, name: "Feed", url: "https://example.com/feed" })
      .returning({ id: schema.newsSources.id });
    if (!source) throw new Error("source fixture");
    const items = await db
      .insert(schema.newsItems)
      .values(
        [1, 2, 3, 4, 5].map((n) => ({
          orgId,
          brandId: brand.id,
          sourceId: source.id,
          title: `Story ${n}`,
          url: `https://example.com/${n}`,
          relevanceStatus: "scored" as const,
          relevanceScore: 0.7,
          relevanceReason: "Old verdict",
          relevanceUrgency: "timely" as const,
          relevanceScoredAt: new Date(),
          ...(n === 2
            ? {
                embedding: Array(KNOWLEDGE_EMBEDDING_DIMENSIONS).fill(0.01),
                embeddingModel: KNOWLEDGE_EMBEDDING_MODEL,
                embeddingDimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
              }
            : {}),
        })),
      )
      .returning({ id: schema.newsItems.id });
    const [batch] = await db
      .insert(schema.relevanceBatches)
      .values({ orgId, brandId: brand.id, days: 7, selectedCount: 2 })
      .returning({ id: schema.relevanceBatches.id });
    if (!batch) throw new Error("batch fixture");
    await db.insert(schema.relevanceBatchItems).values(
      items.slice(0, 2).map((item) => ({
        orgId,
        brandId: brand.id,
        batchId: batch.id,
        itemId: item.id,
      })),
    );
    const first = items[0]?.id as string;
    const second = items[1]?.id as string;
    expect(await repo.claimBatch("other-org", brand.id, batch.id, first)).toBeNull();
    expect(await repo.claimBatch(orgId, brand.id, batch.id, first)).toMatchObject({
      title: "Story 1",
    });
    await repo.recordBatchUsageLoss(orgId, brand.id, batch.id);
    await repo.finishBatch(orgId, brand.id, batch.id, first, {
      kind: "failed",
      code: "model_failed",
    });
    await repo.finishBatch(orgId, brand.id, batch.id, first, {
      kind: "failed",
      code: "model_failed",
    });
    let [progress] = await db
      .select({
        status: schema.relevanceBatches.status,
        processed: schema.relevanceBatches.processedCount,
        failed: schema.relevanceBatches.failedCount,
      })
      .from(schema.relevanceBatches)
      .where(eq(schema.relevanceBatches.id, batch.id));
    expect(progress).toMatchObject({ status: "running", processed: 1, failed: 1 });
    expect(
      (
        await db
          .select({ count: schema.relevanceBatches.unrecordedCalls })
          .from(schema.relevanceBatches)
          .where(eq(schema.relevanceBatches.id, batch.id))
      )[0]?.count,
    ).toBe(1);
    expect(
      (
        await db
          .select({ score: schema.newsItems.relevanceScore })
          .from(schema.newsItems)
          .where(eq(schema.newsItems.id, first))
      )[0]?.score,
    ).toBe(0.7);
    expect(await repo.claimBatch(orgId, brand.id, batch.id, second)).toMatchObject({
      title: "Story 2",
    });
    await repo.finishBatch("other-org", brand.id, batch.id, second, {
      kind: "scored",
      score: 0.2,
      reason: "wrong tenant",
      urgency: "evergreen",
      feedbackDelta: 0,
    });
    await repo.finishBatch(orgId, brand.id, batch.id, second, {
      kind: "scored",
      score: 0.4,
      reason: "Updated",
      urgency: "evergreen",
      feedbackDelta: 0.1,
    });
    [progress] = await db
      .select({
        status: schema.relevanceBatches.status,
        processed: schema.relevanceBatches.processedCount,
        failed: schema.relevanceBatches.failedCount,
      })
      .from(schema.relevanceBatches)
      .where(eq(schema.relevanceBatches.id, batch.id));
    expect(progress).toMatchObject({ status: "partial", processed: 2, failed: 1 });
    expect(
      (
        await db
          .select({
            score: schema.newsItems.relevanceScore,
            embedding: schema.newsItems.embedding,
            embeddingModel: schema.newsItems.embeddingModel,
            embeddingDimensions: schema.newsItems.embeddingDimensions,
          })
          .from(schema.newsItems)
          .where(eq(schema.newsItems.id, second))
      )[0],
    ).toMatchObject({
      score: 0.4,
      embedding: Array(KNOWLEDGE_EMBEDDING_DIMENSIONS).fill(0.01),
      embeddingModel: KNOWLEDGE_EMBEDDING_MODEL,
      embeddingDimensions: KNOWLEDGE_EMBEDDING_DIMENSIONS,
    });

    const [halted] = await db
      .insert(schema.relevanceBatches)
      .values({ orgId, brandId: brand.id, days: 7, selectedCount: 3 })
      .returning({ id: schema.relevanceBatches.id });
    if (!halted) throw new Error("second batch fixture");
    await db.insert(schema.relevanceBatchItems).values(
      items.slice(2).map((item) => ({
        orgId,
        brandId: brand.id,
        batchId: halted.id,
        itemId: item.id,
      })),
    );
    const third = items[2]?.id as string;
    const fourth = items[3]?.id as string;
    const fifth = items[4]?.id as string;
    await repo.claimBatch(orgId, brand.id, halted.id, third);
    await repo.claimBatch(orgId, brand.id, halted.id, fourth);
    await repo.finishBatch(orgId, brand.id, halted.id, third, {
      kind: "failed",
      code: "invalid_key",
      halt: true,
    });
    expect(await repo.claimBatch(orgId, brand.id, halted.id, fifth)).toBeNull();
    const [stopping] = await db
      .select({
        status: schema.relevanceBatches.status,
        processed: schema.relevanceBatches.processedCount,
        failed: schema.relevanceBatches.failedCount,
        skipped: schema.relevanceBatches.skippedCount,
        code: schema.relevanceBatches.errorCode,
      })
      .from(schema.relevanceBatches)
      .where(
        and(eq(schema.relevanceBatches.orgId, orgId), eq(schema.relevanceBatches.id, halted.id)),
      );
    expect(stopping).toEqual({
      status: "halting",
      processed: 2,
      failed: 1,
      skipped: 1,
      code: "invalid_key",
    });
    await expect(
      db
        .insert(schema.relevanceBatches)
        .values({ orgId, brandId: brand.id, days: 7, selectedCount: 1 }),
    ).rejects.toThrow();
    await repo.finishBatch(orgId, brand.id, halted.id, fourth, {
      kind: "scored",
      score: 0.8,
      reason: "Already running",
      urgency: "timely",
      feedbackDelta: 0,
    });
    const [stopped] = await db
      .select({
        status: schema.relevanceBatches.status,
        processed: schema.relevanceBatches.processedCount,
        updated: schema.relevanceBatches.updatedCount,
        code: schema.relevanceBatches.errorCode,
      })
      .from(schema.relevanceBatches)
      .where(eq(schema.relevanceBatches.id, halted.id));
    expect(stopped).toMatchObject({
      status: "halted",
      processed: 3,
      updated: 1,
      code: "invalid_key",
    });

    const [racing] = await db
      .insert(schema.relevanceBatches)
      .values({ orgId, brandId: brand.id, days: 7, selectedCount: 1 })
      .returning({ id: schema.relevanceBatches.id });
    if (!racing) throw new Error("racing batch fixture");
    await db
      .insert(schema.relevanceBatchItems)
      .values({ orgId, brandId: brand.id, batchId: racing.id, itemId: fifth });
    let unlock!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const stop = db.transaction(async (tx) => {
      await tx
        .select({ id: schema.relevanceBatches.id })
        .from(schema.relevanceBatches)
        .where(eq(schema.relevanceBatches.id, racing.id))
        .for("update");
      await tx
        .update(schema.relevanceBatchItems)
        .set({ status: "skipped", completedAt: new Date() })
        .where(eq(schema.relevanceBatchItems.batchId, racing.id));
      await tx
        .update(schema.relevanceBatches)
        .set({ status: "halted", processedCount: 1, skippedCount: 1, completedAt: new Date() })
        .where(eq(schema.relevanceBatches.id, racing.id));
      locked();
      await gate;
    });
    await acquired;
    let claimSettled = false;
    const claim = repo.claimBatch(orgId, brand.id, racing.id, fifth).then((value) => {
      claimSettled = true;
      return value;
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(claimSettled).toBe(false);
    } finally {
      unlock();
      await stop;
    }
    expect(await claim).toBeNull();

    const [orphan] = await db
      .insert(schema.relevanceBatches)
      .values({ orgId, brandId: brand.id, days: 7, selectedCount: 1 })
      .returning({ id: schema.relevanceBatches.id });
    if (!orphan) throw new Error("orphan fixture");
    await db
      .insert(schema.relevanceBatchItems)
      .values({ orgId, brandId: brand.id, batchId: orphan.id, itemId: fifth });
    const missingJobs = await repo.orphanedBatchJobs();
    expect(missingJobs).toContainEqual({
      orgId,
      brandId: brand.id,
      batchId: orphan.id,
      itemId: fifth,
    });
    await repo.finishBatch(orgId, brand.id, orphan.id, fifth, {
      kind: "failed",
      code: "model_failed",
    });
    expect(
      (
        await db
          .select({ status: schema.relevanceBatches.status })
          .from(schema.relevanceBatches)
          .where(eq(schema.relevanceBatches.id, orphan.id))
      )[0]?.status,
    ).toBe("partial");
  });
});
