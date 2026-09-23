import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("RSS persistence e2e", () => {
  let repo: import("./rss.repository").RssRepository;
  let db: ReturnType<typeof import("@pubrick/db").createDb>["db"];
  let pool: ReturnType<typeof import("@pubrick/db").createDb>["pool"];
  let schema: typeof import("@pubrick/db").schema;
  let eq: typeof import("drizzle-orm").eq;
  let and: typeof import("drizzle-orm").and;
  const orgId = randomUUID();
  let brandId: string;
  let sourceId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const module = await import("@pubrick/db");
    schema = module.schema;
    ({ db, pool } = module.createDb(url as string));
    ({ and, eq } = await import("drizzle-orm"));
    const { RssRepository } = await import("./rss.repository");
    repo = new RssRepository();

    await db
      .insert(schema.organization)
      .values({ id: orgId, name: "RSS test", slug: `rss-${orgId}` });
    const brands = await db
      .insert(schema.brands)
      .values({ orgId, name: "Newsroom" })
      .returning({ id: schema.brands.id });
    if (!brands[0]) throw new Error("Brand fixture was not inserted");
    brandId = brands[0].id;
    const sources = await db
      .insert(schema.newsSources)
      .values({
        orgId,
        brandId,
        name: "Journal",
        url: "https://example.com/feed.xml",
      })
      .returning({ id: schema.newsSources.id });
    if (!sources[0]) throw new Error("Source fixture was not inserted");
    sourceId = sources[0].id;
  });

  afterAll(async () => {
    if (db) await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    if (pool) await pool.end();
  });

  it("deduplicates article URLs and does not write across orgs or paused sources", async () => {
    const article = {
      title: "Story",
      summary: "Facts",
      url: "https://example.com/story",
      publishedAt: null,
    };
    await repo.save(orgId, sourceId, "https://example.com/feed.xml", [article]);
    await repo.save(orgId, sourceId, "https://example.com/feed.xml", [article]);
    const rows = await db
      .select({ url: schema.newsItems.url })
      .from(schema.newsItems)
      .where(eq(schema.newsItems.sourceId, sourceId));
    expect(rows).toEqual([{ url: article.url }]);
    expect(await repo.get(randomUUID(), sourceId)).toBeNull();

    await db
      .update(schema.newsSources)
      .set({ isActive: false })
      .where(eq(schema.newsSources.id, sourceId));
    await repo.save(orgId, sourceId, "https://example.com/feed.xml", [
      { ...article, url: "https://example.com/second" },
    ]);
    const after = await db
      .select({ url: schema.newsItems.url })
      .from(schema.newsItems)
      .where(eq(schema.newsItems.sourceId, sourceId));
    expect(after).toEqual([{ url: article.url }]);
  });

  it("stores only a safe private-channel URL and encrypted peer, scoped to the owning brand", async () => {
    const { encryptJson } = await import("@pubrick/shared");
    const key = "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const secret = encryptJson({ channelId: 123456, accessHash: "987654321" }, key);
    await expect(
      repo.addPrivateTelegramSource(randomUUID(), brandId, "Private", 123456, secret),
    ).rejects.toThrow("Brand not found");
    await repo.addPrivateTelegramSource(orgId, brandId, "Private", 123456, secret);
    const [row] = await db
      .select({
        id: schema.newsSources.id,
        url: schema.newsSources.url,
        privatePeerEncrypted: schema.newsSources.privatePeerEncrypted,
        kind: schema.newsSources.kind,
      })
      .from(schema.newsSources)
      .where(
        and(
          eq(schema.newsSources.orgId, orgId),
          eq(schema.newsSources.url, "https://t.me/c/123456"),
        ),
      );
    expect(row).toMatchObject({ kind: "telegram_private", url: "https://t.me/c/123456" });
    expect(row?.privatePeerEncrypted).toBe(secret);
    expect(secret).not.toContain("987654321");
    expect(JSON.stringify(row)).not.toContain("+invite");
    if (!row) throw new Error("Private source fixture was not inserted");
    expect(await repo.get(randomUUID(), row.id)).toBeNull();
    const item = {
      title: "Private story",
      summary: "A private channel post",
      url: "https://t.me/c/123456/1",
      publishedAt: null,
    };
    await repo.save(orgId, row.id, row.url, [item]);
    await repo.save(orgId, row.id, row.url, [item]);
    expect(
      await db
        .select({ id: schema.newsItems.id })
        .from(schema.newsItems)
        .where(eq(schema.newsItems.sourceId, row.id)),
    ).toHaveLength(1);
    await db
      .update(schema.newsSources)
      .set({ isActive: false })
      .where(eq(schema.newsSources.id, row.id));
    await repo.save(orgId, row.id, row.url, [{ ...item, url: "https://t.me/c/123456/2" }]);
    expect(
      await db
        .select({ id: schema.newsItems.id })
        .from(schema.newsItems)
        .where(eq(schema.newsItems.sourceId, row.id)),
    ).toHaveLength(1);
    await db.delete(schema.newsSources).where(eq(schema.newsSources.id, row.id));
    expect(await repo.get(orgId, row.id)).toBeNull();
  });
});
