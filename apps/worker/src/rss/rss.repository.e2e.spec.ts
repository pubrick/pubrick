import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("RSS persistence e2e", () => {
  let repo: import("./rss.repository").RssRepository;
  let db: ReturnType<typeof import("@pubrick/db").createDb>["db"];
  let pool: ReturnType<typeof import("@pubrick/db").createDb>["pool"];
  let schema: typeof import("@pubrick/db").schema;
  let eq: typeof import("drizzle-orm").eq;
  const orgId = randomUUID();
  let brandId: string;
  let sourceId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const module = await import("@pubrick/db");
    schema = module.schema;
    ({ db, pool } = module.createDb(url as string));
    ({ eq } = await import("drizzle-orm"));
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
});
