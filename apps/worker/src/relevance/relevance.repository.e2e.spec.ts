import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("RelevanceRepository (Postgres)", () => {
  let repo: InstanceType<typeof import("./relevance.repository").RelevanceRepository>;
  let db: Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["db"];
  let pool: Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["pool"];
  let schema: typeof import("@pubrick/db").schema;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const dbPackage = await import("@pubrick/db");
    schema = dbPackage.schema;
    ({ db, pool } = dbPackage.createDb(url as string));
    const { RelevanceRepository } = await import("./relevance.repository");
    repo = new RelevanceRepository();
  });

  afterAll(async () => {
    await pool?.end();
    const workerPool = (await import("../db")).pool;
    await workerPool.end();
  });

  it("claims only the owning brand, stores a true zero score, and meters the call independently", async () => {
    const stamp = `rel-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await db
      .insert(schema.organization)
      .values({ id: stamp, name: "Relevance Org", slug: stamp, createdAt: new Date() });
    const [brand] = await db
      .insert(schema.brands)
      .values({ orgId: stamp, name: "Cafe", audience: "Cafe owners" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("Brand seed failed");
    const [source] = await db
      .insert(schema.newsSources)
      .values({ orgId: stamp, brandId: brand.id, name: "Journal", url: "https://example.com/feed" })
      .returning({ id: schema.newsSources.id });
    if (!source) throw new Error("Source seed failed");
    const [item] = await db
      .insert(schema.newsItems)
      .values({
        orgId: stamp,
        brandId: brand.id,
        sourceId: source.id,
        title: "Article",
        summary: "Summary",
        url: "https://example.com/article",
      })
      .returning({ id: schema.newsItems.id });
    if (!item) throw new Error("Article seed failed");
    const [privateSource] = await db
      .insert(schema.newsSources)
      .values({
        orgId: stamp,
        brandId: brand.id,
        name: "Private",
        kind: "telegram_private",
        url: "https://t.me/c/123456",
        privatePeerEncrypted: "encrypted-peer",
      })
      .returning({ id: schema.newsSources.id });
    if (!privateSource) throw new Error("Private source seed failed");
    const [privateItem] = await db
      .insert(schema.newsItems)
      .values({
        orgId: stamp,
        brandId: brand.id,
        sourceId: privateSource.id,
        title: "Private article",
        url: "https://t.me/c/123456/1",
      })
      .returning({ id: schema.newsItems.id });
    if (!privateItem) throw new Error("Private article seed failed");
    expect((await repo.unscored()).some((candidate) => candidate.itemId === privateItem.id)).toBe(
      false,
    );
    expect(await repo.claim("wrong-org", brand.id, item.id)).toBeNull();
    expect(await repo.claim(stamp, "00000000-0000-4000-8000-000000000001", item.id)).toBeNull();
    expect(await repo.claim(stamp, brand.id, item.id)).toMatchObject({
      title: "Article",
      brand: { audience: "Cafe owners" },
    });
    const job = { orgId: stamp, brandId: brand.id, itemId: item.id };
    await repo.recordUsage(stamp, {
      provider: "google",
      modelId: "gemini-3.7-flash",
      attempt: 1,
      inputTokens: 20,
      outputTokens: 10,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      costUsd: 0.000052,
      costSource: "price_table",
      responseMs: 30,
      status: "ok",
      outcome: "completed",
    });
    await repo.scored(job.orgId, job.brandId, job.itemId, {
      score: 0,
      reason: "No fit",
      urgency: "evergreen",
    });
    expect(await repo.claim(stamp, brand.id, item.id)).toBeNull();
    const { eq } = await import("drizzle-orm");
    const [stored] = await db
      .select({
        status: schema.newsItems.relevanceStatus,
        score: schema.newsItems.relevanceScore,
        reason: schema.newsItems.relevanceReason,
        attempts: schema.newsItems.relevanceAttempts,
      })
      .from(schema.newsItems)
      .where(eq(schema.newsItems.id, item.id));
    expect(stored).toEqual({ status: "scored", score: 0, reason: "No fit", attempts: 1 });
    const spend = await db
      .select({
        step: schema.usageLedger.step,
        cost: schema.usageLedger.costUsd,
        inputTokens: schema.usageLedger.inputTokens,
      })
      .from(schema.usageLedger)
      .where(eq(schema.usageLedger.orgId, stamp));
    expect(spend).toEqual([{ step: "news_relevance", cost: "0.000052", inputTokens: 20 }]);

    const [stuck] = await db
      .insert(schema.newsItems)
      .values({
        orgId: stamp,
        brandId: brand.id,
        sourceId: source.id,
        title: "Stuck",
        url: "https://example.com/stuck",
      })
      .returning({ id: schema.newsItems.id });
    if (!stuck) throw new Error("Second article seed failed");
    const stuckJob = { orgId: stamp, brandId: brand.id, itemId: stuck.id };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await repo.claim(stamp, brand.id, stuck.id)).not.toBeNull();
    }
    expect(await repo.claim(stamp, brand.id, stuck.id)).toBeNull();
    await repo.markAttemptLimit(stuckJob.orgId, stuckJob.brandId, stuckJob.itemId);
    const [exhausted] = await db
      .select({ status: schema.newsItems.relevanceStatus, score: schema.newsItems.relevanceScore })
      .from(schema.newsItems)
      .where(eq(schema.newsItems.id, stuck.id));
    expect(exhausted).toEqual({ status: "failed", score: null });
  });
});
