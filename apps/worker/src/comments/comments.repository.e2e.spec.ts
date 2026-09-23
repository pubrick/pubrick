import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("Telegram comment persistence e2e", () => {
  let repo: import("./comments.repository").CommentsRepository;
  let db: ReturnType<typeof import("@pubrick/db").createDb>["db"];
  let pool: ReturnType<typeof import("@pubrick/db").createDb>["pool"];
  let schema: typeof import("@pubrick/db").schema;
  let eq: typeof import("drizzle-orm").eq;
  const orgId = randomUUID();
  let itemId: string;
  const itemUrl = "https://t.me/example_channel/42";

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const module = await import("@pubrick/db");
    schema = module.schema;
    ({ db, pool } = module.createDb(url as string));
    ({ eq } = await import("drizzle-orm"));
    const { CommentsRepository } = await import("./comments.repository");
    repo = new CommentsRepository();
    await db
      .insert(schema.organization)
      .values({ id: orgId, name: "Comments test", slug: `comments-${orgId}` });
    const [brand] = await db
      .insert(schema.brands)
      .values({ orgId, name: "Newsroom" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("Brand fixture was not inserted");
    const [source] = await db
      .insert(schema.newsSources)
      .values({
        orgId,
        brandId: brand.id,
        name: "Channel",
        kind: "telegram",
        url: "https://t.me/example_channel",
      })
      .returning({ id: schema.newsSources.id });
    if (!source) throw new Error("Source fixture was not inserted");
    const [item] = await db
      .insert(schema.newsItems)
      .values({ orgId, brandId: brand.id, sourceId: source.id, title: "Story", url: itemUrl })
      .returning({ id: schema.newsItems.id });
    if (!item) throw new Error("Story fixture was not inserted");
    itemId = item.id;
  });

  afterAll(async () => {
    if (db) await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    if (pool) await pool.end();
  });

  it("replaces only this story's sampled replies and clears them when discussion becomes private", async () => {
    const sample = {
      status: "available" as const,
      comments: [
        {
          messageId: 7,
          body: "Detailed useful reader response",
          publishedAt: new Date("2026-09-23T12:00:00Z"),
        },
      ],
    };
    await repo.save(orgId, itemId, itemUrl, sample);
    expect(await repo.item(randomUUID(), itemId)).toBeNull();
    await repo.save(randomUUID(), itemId, itemUrl, { status: "private", comments: [] });
    let rows = await db
      .select({ body: schema.newsComments.body })
      .from(schema.newsComments)
      .where(eq(schema.newsComments.itemId, itemId));
    expect(rows).toEqual([{ body: "Detailed useful reader response" }]);
    await repo.save(orgId, itemId, itemUrl, { status: "private", comments: [] });
    rows = await db
      .select({ body: schema.newsComments.body })
      .from(schema.newsComments)
      .where(eq(schema.newsComments.itemId, itemId));
    expect(rows).toEqual([]);
    const [item] = await db
      .select({ status: schema.newsItems.commentsStatus })
      .from(schema.newsItems)
      .where(eq(schema.newsItems.id, itemId));
    if (!item) throw new Error("Story was removed unexpectedly");
    expect(item.status).toBe("private");
  });

  it("rejects an unknown comment status at the database boundary", async () => {
    await expect(
      pool.query("UPDATE news_items SET comments_status = $1 WHERE id = $2", ["guessing", itemId]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
