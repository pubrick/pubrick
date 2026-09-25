import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("SuggestionsRepository (Postgres)", () => {
  let repo: InstanceType<typeof import("./suggestions.repository").SuggestionsRepository>;
  let db: Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["db"];
  let pool: Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["pool"];
  let schema: typeof import("@pubrick/db").schema;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const dbPackage = await import("@pubrick/db");
    schema = dbPackage.schema;
    ({ db, pool } = dbPackage.createDb(url as string));
    const { SuggestionsRepository } = await import("./suggestions.repository");
    repo = new SuggestionsRepository();
  });

  afterAll(async () => {
    await pool?.end();
    const workerPool = (await import("../db")).pool;
    await workerPool.end();
  });

  it("uses tenant-scoped input, respects rejected article feedback, deduplicates, and stores unapproved ideas", async () => {
    const stamp = `suggest-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await db
      .insert(schema.organization)
      .values({ id: stamp, name: "Ideas Org", slug: stamp, createdAt: new Date() });
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
    await db.insert(schema.newsItems).values([
      {
        orgId: stamp,
        brandId: brand.id,
        sourceId: source.id,
        title: "Good",
        url: "https://example.com/good",
        relevanceStatus: "scored",
        relevanceScore: 0.8,
        relevanceReason: "Fit",
        relevanceUrgency: "timely",
        relevanceScoredAt: new Date(),
      },
      {
        orgId: stamp,
        brandId: brand.id,
        sourceId: source.id,
        title: "Rejected",
        url: "https://example.com/rejected",
        relevanceStatus: "scored",
        relevanceScore: 0.99,
        relevanceReason: "Fit",
        relevanceUrgency: "timely",
        relevanceScoredAt: new Date(),
        editorSignal: "irrelevant",
      },
      {
        orgId: stamp,
        brandId: brand.id,
        sourceId: source.id,
        title: "Lifted",
        url: "https://example.com/lifted",
        relevanceStatus: "scored",
        relevanceScore: 0.55,
        relevanceFeedbackDelta: 0.15,
        relevanceReason: "Possible fit",
        relevanceUrgency: "timely",
        relevanceScoredAt: new Date(),
      },
      {
        orgId: stamp,
        brandId: brand.id,
        sourceId: source.id,
        title: "Lowered",
        url: "https://example.com/lowered",
        relevanceStatus: "scored",
        relevanceScore: 0.7,
        relevanceFeedbackDelta: -0.2,
        relevanceReason: "Possible fit",
        relevanceUrgency: "timely",
        relevanceScoredAt: new Date(),
      },
    ]);
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
    await db.insert(schema.newsItems).values({
      orgId: stamp,
      brandId: brand.id,
      sourceId: privateSource.id,
      title: "Private scored story",
      url: "https://t.me/c/123456/1",
      relevanceStatus: "scored",
      relevanceScore: 0.99,
      relevanceReason: "Fit",
      relevanceUrgency: "timely",
      relevanceScoredAt: new Date(),
    });
    await db
      .insert(schema.topics)
      .values({ orgId: stamp, brandId: brand.id, title: "Existing Topic", status: "approved" });
    const [request] = await db
      .insert(schema.topicSuggestionRequests)
      .values({ orgId: stamp, brandId: brand.id })
      .returning({ id: schema.topicSuggestionRequests.id });
    if (!request) throw new Error("Request seed failed");
    await expect(
      db.execute(sql`update topics set origin = 'robot' where org_id = ${stamp}`),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      db.execute(
        sql`update topic_suggestion_requests set status = 'maybe' where id = ${request.id}`,
      ),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      db.execute(
        sql`update topic_suggestion_requests set error_code = 'unknown' where id = ${request.id}`,
      ),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    expect(await repo.claim("wrong-org", brand.id, request.id)).toBeNull();
    const claimed = await repo.claim(stamp, brand.id, request.id);
    expect(claimed?.topics).toMatchObject([{ title: "Existing Topic", status: "approved" }]);
    expect(claimed?.news.map((item) => item.title)).toEqual(["Good", "Lifted"]);
    expect(claimed?.news[0]?.score).toBeCloseTo(0.8);
    expect(claimed?.news[1]?.score).toBeCloseTo(0.7);
    const count = await repo.complete(
      stamp,
      brand.id,
      request.id,
      [
        { title: " existing   topic ", description: "Duplicate", newsItemId: null },
        {
          title: "New Cafe Angle",
          description: "A useful brief",
          newsItemId: claimed?.news[0]?.id ?? null,
        },
        { title: "NEW cafe angle", description: "Duplicate in reply", newsItemId: null },
      ],
      claimed?.news ?? [],
    );
    expect(count).toBe(1);
    const topics = await db
      .select({
        title: schema.topics.title,
        status: schema.topics.status,
        origin: schema.topics.origin,
        sourceUrl: schema.topics.sourceUrl,
      })
      .from(schema.topics)
      .where(and(eq(schema.topics.orgId, stamp), eq(schema.topics.brandId, brand.id)));
    expect(topics).toContainEqual({
      title: "New Cafe Angle",
      status: "idea",
      origin: "ai",
      sourceUrl: "https://example.com/good",
    });
    expect(topics).toHaveLength(2);
    expect(await repo.claim(stamp, brand.id, request.id)).toBeNull();
    const [stored] = await db
      .select({
        status: schema.topicSuggestionRequests.status,
        suggestionCount: schema.topicSuggestionRequests.suggestionCount,
      })
      .from(schema.topicSuggestionRequests)
      .where(eq(schema.topicSuggestionRequests.id, request.id));
    expect(stored).toEqual({ status: "succeeded", suggestionCount: 1 });
  });

  it("waits for a reviewer block and rejects its normalized exact title at completion", async () => {
    const orgId = `blocked-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await db
      .insert(schema.organization)
      .values({ id: orgId, name: "Blocked Org", slug: orgId, createdAt: new Date() });
    const [brand] = await db
      .insert(schema.brands)
      .values({ orgId, name: "Brand" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("Brand seed failed");
    const [topic] = await db
      .insert(schema.topics)
      .values({ orgId, brandId: brand.id, title: "Full Width Title" })
      .returning({ id: schema.topics.id });
    const [request] = await db
      .insert(schema.topicSuggestionRequests)
      .values({ orgId, brandId: brand.id })
      .returning({ id: schema.topicSuggestionRequests.id });
    if (!topic || !request) throw new Error("Seed failed");
    let completion: Promise<number> | undefined;
    await db.transaction(async (tx) => {
      await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(eq(schema.brands.id, brand.id))
        .for("no key update");
      completion = repo.complete(
        orgId,
        brand.id,
        request.id,
        [{ title: "  FULL   WIDTH TITLE ", description: "Rejected repeat", newsItemId: null }],
        [],
      );
      await tx
        .update(schema.topics)
        .set({
          blockedAt: new Date(),
          blockReason: "Reviewer veto",
          status: "archived",
          revision: sql`${schema.topics.revision} + 1`,
        })
        .where(eq(schema.topics.id, topic.id));
    });
    expect(await completion).toBe(0);
    const rows = await db
      .select({ title: schema.topics.title })
      .from(schema.topics)
      .where(and(eq(schema.topics.orgId, orgId), eq(schema.topics.brandId, brand.id)));
    expect(rows).toEqual([{ title: "Full Width Title" }]);
  });
});
