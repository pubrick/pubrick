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
        title: "Dismissed but high",
        url: "https://example.com/dismissed-high",
        relevanceStatus: "scored",
        relevanceScore: 0.99,
        relevanceReason: "Fit",
        relevanceUrgency: "timely",
        relevanceScoredAt: new Date(),
        editorSignal: "relevant",
        dismissedAt: new Date(),
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
    const [groupSource] = await db
      .insert(schema.newsSources)
      .values({
        orgId: stamp,
        brandId: brand.id,
        name: "Public group",
        kind: "telegram_group",
        url: "https://t.me/example_group",
      })
      .returning({ id: schema.newsSources.id });
    if (!groupSource) throw new Error("Group source seed failed");
    await db.insert(schema.newsItems).values({
      orgId: stamp,
      brandId: brand.id,
      sourceId: groupSource.id,
      title: "Public group scored story",
      url: "https://t.me/example_group/1",
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
        inspirationKind: schema.topics.inspirationKind,
        inspirationRefId: schema.topics.inspirationRefId,
        inspirationLabel: schema.topics.inspirationLabel,
        inspirationDate: schema.topics.inspirationDate,
      })
      .from(schema.topics)
      .where(and(eq(schema.topics.orgId, stamp), eq(schema.topics.brandId, brand.id)));
    expect(topics).toContainEqual({
      title: "New Cafe Angle",
      status: "idea",
      origin: "ai",
      sourceUrl: "https://example.com/good",
      inspirationKind: "news",
      inspirationRefId: claimed?.news[0]?.id,
      inspirationLabel: "Good",
      inspirationDate: null,
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

  it("samples only upcoming brand calendar signals and rejects foreign or invented references", async () => {
    const orgId = `calendar-ideas-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await db
      .insert(schema.organization)
      .values({ id: orgId, name: "Calendar ideas", slug: orgId, createdAt: new Date() });
    const [brand, other] = await db
      .insert(schema.brands)
      .values([
        { orgId, name: "Cafe" },
        { orgId, name: "Other" },
      ])
      .returning({ id: schema.brands.id });
    if (!brand || !other) throw new Error("Brand seed failed");
    const today = new Date().toISOString().slice(0, 10);
    const plus = (days: number) =>
      new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
    const [opening] = await db
      .insert(schema.editorialPlaceholders)
      .values({
        orgId,
        brandId: brand.id,
        date: plus(13),
        platform: "telegram",
        notes: "Never send this to AI",
      })
      .returning({ id: schema.editorialPlaceholders.id });
    const [lateOpening] = await db
      .insert(schema.editorialPlaceholders)
      .values({
        orgId,
        brandId: brand.id,
        date: plus(14),
      })
      .returning({ id: schema.editorialPlaceholders.id });
    const [foreignOpening] = await db
      .insert(schema.editorialPlaceholders)
      .values({
        orgId,
        brandId: other.id,
        date: plus(1),
      })
      .returning({ id: schema.editorialPlaceholders.id });
    const [date] = await db
      .insert(schema.memorableDates)
      .values({
        orgId,
        brandId: brand.id,
        monthDay: plus(3).slice(5),
        title: "Seasonal occasion",
        leadDays: 3,
      })
      .returning({ id: schema.memorableDates.id });
    await db.insert(schema.memorableDates).values([
      { orgId, brandId: brand.id, monthDay: plus(4).slice(5), title: "Too early", leadDays: 2 },
      {
        orgId,
        brandId: brand.id,
        monthDay: plus(2).slice(5),
        title: "Inactive",
        leadDays: 7,
        isActive: false,
      },
      { orgId, brandId: other.id, monthDay: plus(1).slice(5), title: "Foreign date", leadDays: 7 },
    ]);
    const [request] = await db
      .insert(schema.topicSuggestionRequests)
      .values({ orgId, brandId: brand.id })
      .returning({ id: schema.topicSuggestionRequests.id });
    if (!opening || !lateOpening || !foreignOpening || !date || !request)
      throw new Error("Calendar seed failed");
    const claimed = await repo.claim(orgId, brand.id, request.id);
    expect(claimed?.calendarToday).toBe(today);
    expect(claimed?.calendar.placeholders.map((item) => item.id)).toEqual([opening.id]);
    expect(claimed?.calendar.placeholders[0]).not.toHaveProperty("notes");
    expect(claimed?.calendar.memorable).toMatchObject([
      { id: date.id, date: plus(3), daysUntil: 3 },
    ]);
    const count = await repo.complete(
      orgId,
      brand.id,
      request.id,
      [
        {
          title: "Opening plan",
          description: "Brief",
          newsItemId: null,
          editorialPlaceholderId: opening.id,
        },
        {
          title: "Seasonal plan",
          description: "Brief",
          newsItemId: null,
          memorableDateId: date.id,
        },
        {
          title: "Foreign plan",
          description: "Brief",
          newsItemId: null,
          editorialPlaceholderId: foreignOpening.id,
        },
      ],
      [],
      1,
      undefined,
      claimed?.calendar,
    );
    expect(count).toBe(2);
    const saved = await db
      .select({
        title: schema.topics.title,
        status: schema.topics.status,
        plannedDate: schema.topics.plannedDate,
        inspirationKind: schema.topics.inspirationKind,
        inspirationRefId: schema.topics.inspirationRefId,
        inspirationLabel: schema.topics.inspirationLabel,
        inspirationDate: schema.topics.inspirationDate,
      })
      .from(schema.topics)
      .where(and(eq(schema.topics.orgId, orgId), eq(schema.topics.brandId, brand.id)));
    expect(saved).toEqual(
      expect.arrayContaining([
        {
          title: "Opening plan",
          status: "idea",
          plannedDate: null,
          inspirationKind: "editorial_placeholder",
          inspirationRefId: opening.id,
          inspirationLabel: "Editorial opening",
          inspirationDate: plus(13),
        },
        {
          title: "Seasonal plan",
          status: "idea",
          plannedDate: null,
          inspirationKind: "memorable_date",
          inspirationRefId: date.id,
          inspirationLabel: "Seasonal occasion",
          inspirationDate: plus(3),
        },
      ]),
    );
    expect(saved).toHaveLength(2);
    await db
      .delete(schema.editorialPlaceholders)
      .where(eq(schema.editorialPlaceholders.id, opening.id));
    await db.delete(schema.memorableDates).where(eq(schema.memorableDates.id, date.id));
    const retained = await db
      .select({
        title: schema.topics.title,
        label: schema.topics.inspirationLabel,
        date: schema.topics.inspirationDate,
      })
      .from(schema.topics)
      .where(and(eq(schema.topics.orgId, orgId), eq(schema.topics.brandId, brand.id)));
    expect(retained).toEqual(
      expect.arrayContaining([
        { title: "Opening plan", label: "Editorial opening", date: plus(13) },
        { title: "Seasonal plan", label: "Seasonal occasion", date: plus(3) },
      ]),
    );
    const slots = await db
      .select({ id: schema.calendarSlots.id })
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.brandId, brand.id));
    expect(slots).toHaveLength(0);
    const [secondRequest] = await db
      .insert(schema.topicSuggestionRequests)
      .values({ orgId, brandId: brand.id })
      .returning({ id: schema.topicSuggestionRequests.id });
    if (!secondRequest) throw new Error("Second request seed failed");
    const secondClaim = await repo.claim(orgId, brand.id, secondRequest.id);
    expect(
      await repo.complete(
        orgId,
        brand.id,
        secondRequest.id,
        [
          {
            title: "Invented opening",
            description: "Brief",
            newsItemId: null,
            editorialPlaceholderId: "00000000-0000-4000-8000-000000000007",
          },
          {
            title: "Invented article",
            description: "Brief",
            newsItemId: "00000000-0000-4000-8000-000000000008",
          },
        ],
        [],
        1,
        undefined,
        secondClaim?.calendar,
      ),
    ).toBe(0);
    await expect(
      db.execute(
        sql`INSERT INTO topics (org_id, brand_id, title, inspiration_kind, inspiration_ref_id) VALUES (${orgId}, ${brand.id}, 'Broken', 'news', ${opening.id})`,
      ),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
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

  it("includes manually created reviewer blocks and refuses a changed snapshot under the brand lock", async () => {
    const orgId = `semantic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await db
      .insert(schema.organization)
      .values({ id: orgId, name: "Semantic Org", slug: orgId, createdAt: new Date() });
    const [brand] = await db
      .insert(schema.brands)
      .values({ orgId, name: "Brand" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("Brand seed failed");
    const [blocked] = await db
      .insert(schema.topics)
      .values({
        orgId,
        brandId: brand.id,
        title: "Coffee workflow",
        origin: "manual",
        status: "archived",
        blockedAt: new Date(),
        blockReason: "Wrong angle",
      })
      .returning({ id: schema.topics.id });
    const [request] = await db
      .insert(schema.topicSuggestionRequests)
      .values({ orgId, brandId: brand.id, status: "running", attempts: 1 })
      .returning({ id: schema.topicSuggestionRequests.id });
    if (!blocked || !request) throw new Error("Seed failed");
    const snapshot = await repo.recentBlocked(orgId, brand.id);
    expect(snapshot?.titles).toEqual(["Coffee workflow"]);
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
        [{ title: "Better coffee workflow", description: "A nearby idea", newsItemId: null }],
        [],
        1,
        snapshot ?? undefined,
      );
      await tx
        .update(schema.topics)
        .set({
          title: "Coffee workflow for staff",
          revision: sql`${schema.topics.revision} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(schema.topics.id, blocked.id));
    });
    expect(await completion).toBe(0);
    const [stored] = await db
      .select({
        status: schema.topicSuggestionRequests.status,
        errorCode: schema.topicSuggestionRequests.errorCode,
      })
      .from(schema.topicSuggestionRequests)
      .where(eq(schema.topicSuggestionRequests.id, request.id));
    expect(stored).toEqual({ status: "failed", errorCode: "model_failed" });
    const ideas = await db
      .select({ title: schema.topics.title })
      .from(schema.topics)
      .where(and(eq(schema.topics.orgId, orgId), eq(schema.topics.brandId, brand.id)));
    expect(ideas).toEqual([{ title: "Coffee workflow for staff" }]);
  });

  it("refuses a partial sample when the recent blocked set exceeds the manual cap", async () => {
    const orgId = `semantic-cap-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await db
      .insert(schema.organization)
      .values({ id: orgId, name: "Cap Org", slug: orgId, createdAt: new Date() });
    const [brand] = await db
      .insert(schema.brands)
      .values({ orgId, name: "Brand" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("Brand seed failed");
    await db.insert(schema.topics).values(
      Array.from({ length: 21 }, (_, index) => ({
        orgId,
        brandId: brand.id,
        title: `Blocked angle ${index}`,
        origin: "manual" as const,
        status: "archived" as const,
        blockedAt: new Date(),
        blockReason: "Reviewer veto",
      })),
    );
    expect(await repo.recentBlocked(orgId, brand.id)).toBeNull();
  });
});
