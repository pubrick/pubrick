import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("automatic public Telegram comment collection", () => {
  let repo: import("./comments.repository").CommentsRepository;
  let db: ReturnType<typeof import("@pubrick/db").createDb>["db"];
  let pool: ReturnType<typeof import("@pubrick/db").createDb>["pool"];
  let schema: typeof import("@pubrick/db").schema;
  let eq: typeof import("drizzle-orm").eq;
  const orgs: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const module = await import("@pubrick/db");
    schema = module.schema;
    ({ db, pool } = module.createDb(url as string));
    ({ eq } = await import("drizzle-orm"));
    repo = new (await import("./comments.repository")).CommentsRepository();
  });

  afterEach(async () => {
    for (const orgId of orgs.splice(0))
      await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
  });
  afterAll(async () => {
    if (pool) await pool.end();
  });

  async function fixture() {
    const orgId = randomUUID();
    orgs.push(orgId);
    await db
      .insert(schema.organization)
      .values({ id: orgId, name: "Auto comments", slug: `auto-comments-${orgId}` });
    const [brand] = await db
      .insert(schema.brands)
      .values({ orgId, name: "Brand" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("brand fixture");
    const brandId = brand.id;
    const [source] = await db
      .insert(schema.newsSources)
      .values({
        orgId,
        brandId,
        name: "Public",
        kind: "telegram",
        url: "https://t.me/example_channel",
      })
      .returning({ id: schema.newsSources.id });
    if (!source) throw new Error("source fixture");
    await db.insert(schema.telegramSourceAccounts).values({ orgId, sessionEncrypted: "test-only" });
    await db
      .insert(schema.newsCommentCollectionConfigs)
      .values({ orgId, brandId, enabled: true, revision: 1 });
    return { orgId, brandId, sourceId: source.id };
  }

  async function story(
    f: Awaited<ReturnType<typeof fixture>>,
    n: number,
    overrides: Record<string, unknown> = {},
  ) {
    const [row] = await db
      .insert(schema.newsItems)
      .values({
        orgId: f.orgId,
        brandId: f.brandId,
        sourceId: f.sourceId,
        title: `Story ${n}`,
        url: `https://t.me/example_channel/${n}`,
        publishedAt: new Date(Date.now() - 7 * 3600_000),
        relevanceStatus: "scored",
        relevanceScore: 0.7,
        relevanceReason: "Relevant",
        relevanceUrgency: "timely",
        relevanceScoredAt: new Date(),
        ...overrides,
      } as typeof schema.newsItems.$inferInsert)
      .returning({ id: schema.newsItems.id });
    if (!row) throw new Error("story fixture");
    return row.id;
  }

  function boss() {
    const send = vi.fn().mockResolvedValue(randomUUID());
    return { send, instance: { send } as never };
  }

  it("uses raw score, exact six-hour boundary, source state and prior checks", async () => {
    const f = await fixture();
    const eligible = await story(f, 1);
    await pool.query(
      "UPDATE news_items SET published_at = clock_timestamp() - interval '6 hours' WHERE id = $1",
      [eligible],
    );
    await story(f, 2, { relevanceScore: 0.699, relevanceFeedbackDelta: 0.2 });
    const tooYoung = await story(f, 3);
    await pool.query(
      "UPDATE news_items SET published_at = clock_timestamp() - interval '6 hours' + interval '1 second' WHERE id = $1",
      [tooYoung],
    );
    await story(f, 4, { commentsCheckedAt: new Date(), commentsStatus: "available" });
    await story(f, 5, { commentsStatus: "pending" });
    const [paused] = await db
      .insert(schema.newsSources)
      .values({
        orgId: f.orgId,
        brandId: f.brandId,
        name: "Paused",
        kind: "telegram",
        url: "https://t.me/paused_channel",
        isActive: false,
      })
      .returning({ id: schema.newsSources.id });
    const [privateSource] = await db
      .insert(schema.newsSources)
      .values({
        orgId: f.orgId,
        brandId: f.brandId,
        name: "Private",
        kind: "telegram_private",
        url: "https://t.me/c/123456",
        privatePeerEncrypted: "test-only",
      })
      .returning({ id: schema.newsSources.id });
    if (!paused || !privateSource) throw new Error("source fixtures");
    await story(f, 6, { sourceId: paused.id });
    await story(f, 7, { sourceId: privateSource.id });
    const { send, instance } = boss();
    expect(await repo.scanAuto(instance)).toBe(1);
    expect(send).toHaveBeenCalledWith(
      "telegram-comments",
      expect.objectContaining({ itemId: eligible, kind: "news_auto", revision: 1 }),
      expect.any(Object),
    );
    expect(send.mock.calls[0]?.[2]).toMatchObject({
      singletonKey: eligible,
      singletonSeconds: 900,
    });
    expect(
      await repo.eligibleAuto({
        kind: "news_auto",
        orgId: f.orgId,
        brandId: f.brandId,
        itemId: eligible,
        revision: 1,
      }),
    ).toMatchObject({ url: "https://t.me/example_channel/1" });
    await db
      .update(schema.newsSources)
      .set({ isActive: false })
      .where(eq(schema.newsSources.id, f.sourceId));
    expect(
      await repo.eligibleAuto({
        kind: "news_auto",
        orgId: f.orgId,
        brandId: f.brandId,
        itemId: eligible,
        revision: 1,
      }),
    ).toBeNull();
  });

  it("fences old jobs across off-on cycles and prevents duplicate sample writes", async () => {
    const f = await fixture();
    const itemId = await story(f, 10);
    const job = {
      kind: "news_auto" as const,
      orgId: f.orgId,
      brandId: f.brandId,
      itemId,
      revision: 1,
    };
    const sample = {
      status: "available" as const,
      comments: Array.from({ length: 51 }, (_, index) => ({
        messageId: index + 1,
        body: "Reply",
        publishedAt: new Date(),
      })),
    };
    await db
      .update(schema.newsCommentCollectionConfigs)
      .set({ enabled: false, revision: 2 })
      .where(eq(schema.newsCommentCollectionConfigs.brandId, f.brandId));
    await repo.saveAuto(job, "https://t.me/example_channel/10", sample);
    await db
      .update(schema.newsCommentCollectionConfigs)
      .set({ enabled: true, revision: 3 })
      .where(eq(schema.newsCommentCollectionConfigs.brandId, f.brandId));
    expect(await repo.eligibleAuto(job)).toBeNull();
    await repo.saveAuto(job, "https://t.me/example_channel/10", sample);
    expect(
      await db.select().from(schema.newsComments).where(eq(schema.newsComments.itemId, itemId)),
    ).toHaveLength(0);
    await repo.saveAuto({ ...job, revision: 3 }, "https://t.me/example_channel/10", sample);
    await repo.saveAuto({ ...job, revision: 3 }, "https://t.me/example_channel/10", sample);
    expect(
      await db.select().from(schema.newsComments).where(eq(schema.newsComments.itemId, itemId)),
    ).toHaveLength(50);
  });

  it("discards an in-flight Telegram response when collection is disabled", async () => {
    const f = await fixture();
    const itemId = await story(f, 20);
    const job = {
      kind: "news_auto" as const,
      orgId: f.orgId,
      brandId: f.brandId,
      itemId,
      revision: 1,
    };
    const telegram = {
      comments: vi.fn(async () => {
        await db
          .update(schema.newsCommentCollectionConfigs)
          .set({ enabled: false, revision: 2 })
          .where(eq(schema.newsCommentCollectionConfigs.brandId, f.brandId));
        return {
          status: "available" as const,
          comments: [{ messageId: 1, body: "Late", publishedAt: new Date() }],
        };
      }),
    };
    const service = new (await import("./comments.service")).CommentsService(
      repo,
      telegram as never,
    );
    await service.handle(job);
    expect(telegram.comments).toHaveBeenCalledOnce();
    expect(
      await db.select().from(schema.newsComments).where(eq(schema.newsComments.itemId, itemId)),
    ).toHaveLength(0);
    const [item] = await db
      .select({ checkedAt: schema.newsItems.commentsCheckedAt })
      .from(schema.newsItems)
      .where(eq(schema.newsItems.id, itemId));
    expect(item?.checkedAt).toBeNull();
  });

  it("caps each brand at 50 and leaves lost jobs eligible for a later scan", async () => {
    const f = await fixture();
    for (let n = 100; n < 155; n++) await story(f, n);
    const { send, instance } = boss();
    expect(await repo.scanAuto(instance)).toBe(50);
    expect(send).toHaveBeenCalledTimes(50);
    await db
      .update(schema.newsCommentCollectionConfigs)
      .set({ lastScannedAt: new Date(Date.now() - 3601_000) })
      .where(eq(schema.newsCommentCollectionConfigs.brandId, f.brandId));
    expect(await repo.scanAuto(instance)).toBe(50);
    expect(send).toHaveBeenCalledTimes(100);
  });

  it("rolls back scan state when enqueue fails", async () => {
    const f = await fixture();
    await story(f, 500);
    const send = vi.fn().mockRejectedValue(new Error("queue unavailable"));
    await expect(repo.scanAuto({ send } as never)).rejects.toThrow("queue unavailable");
    const [config] = await db
      .select({ scannedAt: schema.newsCommentCollectionConfigs.lastScannedAt })
      .from(schema.newsCommentCollectionConfigs)
      .where(eq(schema.newsCommentCollectionConfigs.brandId, f.brandId));
    expect(config?.scannedAt).toBeNull();
  });

  it("pages brands fairly and never exceeds the per-scan global cap", async () => {
    const fixtures = [];
    for (let brand = 0; brand < 11; brand++) {
      const f = await fixture();
      fixtures.push(f);
      await db.insert(schema.newsItems).values(
        Array.from({ length: 51 }, (_, index) => ({
          orgId: f.orgId,
          brandId: f.brandId,
          sourceId: f.sourceId,
          title: `Story ${brand}-${index}`,
          url: `https://t.me/example_channel/${brand * 1000 + index + 1}`,
          publishedAt: new Date(Date.now() - 7 * 3600_000),
          relevanceStatus: "scored" as const,
          relevanceScore: 0.7,
          relevanceReason: "Relevant",
          relevanceUrgency: "timely" as const,
          relevanceScoredAt: new Date(),
        })),
      );
    }
    const { send, instance } = boss();
    expect(await repo.scanAuto(instance)).toBe(500);
    expect(send).toHaveBeenCalledTimes(500);
    expect(await repo.scanAuto(instance)).toBe(50);
    for (const f of fixtures) {
      const [config] = await db
        .select({ scannedAt: schema.newsCommentCollectionConfigs.lastScannedAt })
        .from(schema.newsCommentCollectionConfigs)
        .where(eq(schema.newsCommentCollectionConfigs.brandId, f.brandId));
      expect(config?.scannedAt).not.toBeNull();
    }
  });
});
