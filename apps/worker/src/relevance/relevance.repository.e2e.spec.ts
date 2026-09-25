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
    const embedding = [1, ...Array(767).fill(0)] as number[];
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
    const [hiddenItem] = await db
      .insert(schema.newsItems)
      .values({
        orgId: stamp,
        brandId: brand.id,
        sourceId: source.id,
        title: "Dismissed article",
        url: "https://example.com/dismissed",
        dismissedAt: new Date(),
      })
      .returning({ id: schema.newsItems.id });
    if (!hiddenItem) throw new Error("Dismissed article seed failed");
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
    await db.insert(schema.newsItems).values([
      {
        orgId: stamp,
        brandId: brand.id,
        sourceId: source.id,
        title: "Matching editorial choice",
        url: "https://example.com/marked-positive",
        editorSignal: "relevant",
        embedding,
        embeddingModel: "gemini-embedding-001",
        embeddingDimensions: 768,
      },
      {
        orgId: stamp,
        brandId: brand.id,
        sourceId: source.id,
        title: "Rejected editorial choice",
        url: "https://example.com/marked-negative",
        editorSignal: "irrelevant",
      },
    ]);
    const [siblingBrand] = await db
      .insert(schema.brands)
      .values({ orgId: stamp, name: "Sibling brand" })
      .returning({ id: schema.brands.id });
    if (!siblingBrand) throw new Error("Sibling brand seed failed");
    const [siblingSource] = await db
      .insert(schema.newsSources)
      .values({
        orgId: stamp,
        brandId: siblingBrand.id,
        name: "Sibling journal",
        url: "https://sibling.example/feed",
      })
      .returning({ id: schema.newsSources.id });
    if (!siblingSource) throw new Error("Sibling source seed failed");
    await db.insert(schema.newsItems).values({
      orgId: stamp,
      brandId: siblingBrand.id,
      sourceId: siblingSource.id,
      title: "Sibling brand feedback",
      url: "https://sibling.example/marked",
      editorSignal: "relevant",
    });
    const otherOrg = `${stamp}-other`;
    await db
      .insert(schema.organization)
      .values({ id: otherOrg, name: "Other org", slug: otherOrg, createdAt: new Date() });
    const [otherBrand] = await db
      .insert(schema.brands)
      .values({ orgId: otherOrg, name: "Other brand" })
      .returning({ id: schema.brands.id });
    if (!otherBrand) throw new Error("Other brand seed failed");
    const [otherSource] = await db
      .insert(schema.newsSources)
      .values({
        orgId: otherOrg,
        brandId: otherBrand.id,
        name: "Other journal",
        url: "https://other.example/feed",
      })
      .returning({ id: schema.newsSources.id });
    if (!otherSource) throw new Error("Other source seed failed");
    await db.insert(schema.newsItems).values({
      orgId: otherOrg,
      brandId: otherBrand.id,
      sourceId: otherSource.id,
      title: "Other organization's feedback",
      url: "https://other.example/marked",
      editorSignal: "relevant",
    });
    expect(await repo.googleKey(stamp)).toBeUndefined();
    const { encryptJson } = await import("@pubrick/shared");
    await db.insert(schema.aiCredentials).values({
      orgId: stamp,
      provider: "google",
      credentialsEncrypted: encryptJson(
        { apiKey: "scoped-google-key" },
        process.env.APP_ENCRYPTION_KEY as string,
      ),
    });
    expect(await repo.googleKey(stamp)).toBe("scoped-google-key");
    expect(await repo.googleKey(otherOrg)).toBeUndefined();
    expect(await repo.recentFeedback(stamp, brand.id, item.id)).toEqual({
      relevant: [
        {
          title: "Matching editorial choice",
          summary: "",
          embedding,
          embeddingModel: "gemini-embedding-001",
          embeddingDimensions: 768,
        },
      ],
      irrelevant: [
        {
          title: "Rejected editorial choice",
          summary: "",
          embedding: null,
          embeddingModel: null,
          embeddingDimensions: null,
        },
      ],
    });
    expect(await repo.recentFeedback(otherOrg, otherBrand.id, item.id)).toEqual({
      relevant: [
        {
          title: "Other organization's feedback",
          summary: "",
          embedding: null,
          embeddingModel: null,
          embeddingDimensions: null,
        },
      ],
      irrelevant: [],
    });
    expect(await repo.recentFeedback(stamp, siblingBrand.id, item.id)).toEqual({
      relevant: [
        {
          title: "Sibling brand feedback",
          summary: "",
          embedding: null,
          embeddingModel: null,
          embeddingDimensions: null,
        },
      ],
      irrelevant: [],
    });
    expect((await repo.unscored()).some((candidate) => candidate.itemId === privateItem.id)).toBe(
      false,
    );
    expect((await repo.unscored()).some((candidate) => candidate.itemId === hiddenItem.id)).toBe(
      false,
    );
    expect(await repo.claim(stamp, brand.id, hiddenItem.id)).toBeNull();
    expect(await repo.isVisible(stamp, brand.id, hiddenItem.id)).toBe(false);
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
    await repo.recordEmbeddingUsage(stamp, 12, 31, "ok", "completed");
    await repo.scored(job.orgId, job.brandId, job.itemId, {
      score: 0,
      feedbackDelta: 0.12,
      reason: "No fit",
      urgency: "evergreen",
      embedding,
    });
    expect(await repo.claim(stamp, brand.id, item.id)).toBeNull();
    const { eq, sql } = await import("drizzle-orm");
    const [stored] = await db
      .select({
        status: schema.newsItems.relevanceStatus,
        score: schema.newsItems.relevanceScore,
        feedbackDelta: schema.newsItems.relevanceFeedbackDelta,
        reason: schema.newsItems.relevanceReason,
        attempts: schema.newsItems.relevanceAttempts,
        embedding: schema.newsItems.embedding,
        embeddingModel: schema.newsItems.embeddingModel,
        embeddingDimensions: schema.newsItems.embeddingDimensions,
      })
      .from(schema.newsItems)
      .where(eq(schema.newsItems.id, item.id));
    expect(stored).toEqual({
      status: "scored",
      score: 0,
      feedbackDelta: 0.12,
      reason: "No fit",
      attempts: 1,
      embedding,
      embeddingModel: "gemini-embedding-001",
      embeddingDimensions: 768,
    });
    await expect(
      db.execute(sql`UPDATE news_items SET relevance_feedback_delta = 0.21 WHERE id = ${item.id}`),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    const spend = await db
      .select({
        step: schema.usageLedger.step,
        cost: schema.usageLedger.costUsd,
        inputTokens: schema.usageLedger.inputTokens,
      })
      .from(schema.usageLedger)
      .where(eq(schema.usageLedger.orgId, stamp));
    expect(spend).toEqual(
      expect.arrayContaining([
        { step: "news_relevance", cost: "0.000052", inputTokens: 20 },
        { step: "news_feedback_embedding", cost: null, inputTokens: 12 },
      ]),
    );

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
