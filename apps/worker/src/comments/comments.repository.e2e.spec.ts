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
  let brandId: string;
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
    brandId = brand.id;
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

  it("replaces only this story's sampled replies and retains them when discussion becomes private", async () => {
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
    const [saved] = await db
      .select({ version: schema.newsItems.commentsSampleVersion })
      .from(schema.newsItems)
      .where(eq(schema.newsItems.id, itemId));
    expect(saved?.version).toBeTruthy();
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
    expect(rows).toEqual([{ body: "Detailed useful reader response" }]);
    const [item] = await db
      .select({
        status: schema.newsItems.commentsStatus,
        version: schema.newsItems.commentsSampleVersion,
      })
      .from(schema.newsItems)
      .where(eq(schema.newsItems.id, itemId));
    if (!item) throw new Error("Story was removed unexpectedly");
    expect(item.status).toBe("private");
    expect(item.version).toBe(saved?.version);
  });

  it("rejects an unknown comment status at the database boundary", async () => {
    await expect(
      pool.query("UPDATE news_items SET comments_status = $1 WHERE id = $2", ["guessing", itemId]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("retains bounded publication replies across errors, rejects stale jobs and erases them with the brand", async () => {
    const { encryptJson } = await import("@pubrick/shared");
    const [channel] = await db
      .insert(schema.channels)
      .values({
        orgId,
        brandId,
        platform: "telegram",
        name: "Public",
        credentialsEncrypted: encryptJson(
          { botToken: "123:abc", chatId: "@pubrick" },
          process.env.APP_ENCRYPTION_KEY ?? "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=",
        ),
      })
      .returning({ id: schema.channels.id });
    if (!channel) throw new Error("No channel");
    const [content] = await db
      .insert(schema.contentItems)
      .values({
        orgId,
        brandId,
        body: "Published body",
        status: "published",
      })
      .returning({ id: schema.contentItems.id });
    if (!content) throw new Error("No content");
    const [adaptation] = await db
      .insert(schema.adaptations)
      .values({
        orgId,
        contentItemId: content.id,
        channelId: channel.id,
        status: "published",
      })
      .returning({ id: schema.adaptations.id });
    if (!adaptation) throw new Error("No adaptation");
    const [publication] = await db
      .insert(schema.publications)
      .values({
        orgId,
        adaptationId: adaptation.id,
        channelId: channel.id,
        status: "published",
        externalId: "42",
        externalUrl: itemUrl,
      })
      .returning({ id: schema.publications.id });
    if (!publication) throw new Error("No publication");
    const requestedAt = new Date("2026-09-25T00:00:00.000Z");
    await db.insert(schema.publicationCommentSamples).values({
      orgId,
      brandId,
      publicationId: publication.id,
      status: "pending",
      requestedAt,
    });
    const job = {
      kind: "publication" as const,
      orgId,
      brandId,
      publicationId: publication.id,
      requestedAt: requestedAt.toISOString(),
    };
    expect(await repo.publication(randomUUID(), brandId, publication.id)).toBeNull();
    expect(await repo.publication(orgId, randomUUID(), publication.id)).toBeNull();
    expect(await repo.publication(orgId, brandId, publication.id)).toMatchObject({ url: itemUrl });
    await repo.savePublication(job, itemUrl, {
      status: "available",
      comments: Array.from({ length: 51 }, (_, i) => ({
        messageId: i + 1,
        body: `Reply ${i + 1}`,
        publishedAt: new Date("2026-09-25T00:01:00Z"),
      })),
    });
    let rows = await db
      .select({ body: schema.publicationComments.body })
      .from(schema.publicationComments)
      .where(eq(schema.publicationComments.publicationId, publication.id));
    expect(rows).toHaveLength(50);
    await db
      .update(schema.publicationCommentSamples)
      .set({ status: "pending" })
      .where(eq(schema.publicationCommentSamples.publicationId, publication.id));
    await repo.failPublication(
      { ...job, requestedAt: "2026-09-24T00:00:00.000Z" },
      itemUrl,
      "telegram_collection_failed",
    );
    let [sample] = await db
      .select({ status: schema.publicationCommentSamples.status })
      .from(schema.publicationCommentSamples)
      .where(eq(schema.publicationCommentSamples.publicationId, publication.id));
    expect(sample?.status).toBe("pending");
    await repo.failPublication(job, itemUrl, "telegram_collection_failed");
    [sample] = await db
      .select({ status: schema.publicationCommentSamples.status })
      .from(schema.publicationCommentSamples)
      .where(eq(schema.publicationCommentSamples.publicationId, publication.id));
    expect(sample?.status).toBe("error");
    rows = await db
      .select({ body: schema.publicationComments.body })
      .from(schema.publicationComments)
      .where(eq(schema.publicationComments.publicationId, publication.id));
    expect(rows).toHaveLength(50);
    await db
      .update(schema.publicationCommentSamples)
      .set({ status: "pending", errorCode: null })
      .where(eq(schema.publicationCommentSamples.publicationId, publication.id));
    await repo.savePublication(job, itemUrl, { status: "private", comments: [] });
    rows = await db
      .select({ body: schema.publicationComments.body })
      .from(schema.publicationComments)
      .where(eq(schema.publicationComments.publicationId, publication.id));
    expect(rows).toHaveLength(50);
    await db
      .update(schema.publicationCommentSamples)
      .set({ status: "pending" })
      .where(eq(schema.publicationCommentSamples.publicationId, publication.id));
    await repo.savePublication(job, itemUrl, { status: "available", comments: [] });
    [sample] = await db
      .select({ status: schema.publicationCommentSamples.status })
      .from(schema.publicationCommentSamples)
      .where(eq(schema.publicationCommentSamples.publicationId, publication.id));
    expect(sample?.status).toBe("no_comments");
    expect(
      await db
        .select()
        .from(schema.publicationComments)
        .where(eq(schema.publicationComments.publicationId, publication.id)),
    ).toEqual([]);
    await db.delete(schema.channels).where(eq(schema.channels.id, channel.id));
    expect(await repo.publication(orgId, brandId, publication.id)).toBeNull();
    await db
      .update(schema.publicationCommentSamples)
      .set({ status: "pending" })
      .where(eq(schema.publicationCommentSamples.publicationId, publication.id));
    await repo.savePublication(job, itemUrl, {
      status: "available",
      comments: [{ messageId: 99, body: "Late reply", publishedAt: new Date() }],
    });
    [sample] = await db
      .select({ status: schema.publicationCommentSamples.status })
      .from(schema.publicationCommentSamples)
      .where(eq(schema.publicationCommentSamples.publicationId, publication.id));
    expect(sample?.status).toBe("pending");
    await db.delete(schema.brands).where(eq(schema.brands.id, brandId));
    expect(
      await db
        .select()
        .from(schema.publicationCommentSamples)
        .where(eq(schema.publicationCommentSamples.publicationId, publication.id)),
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(schema.publicationComments)
        .where(eq(schema.publicationComments.publicationId, publication.id)),
    ).toEqual([]);
    expect(
      await db.select().from(schema.publications).where(eq(schema.publications.id, publication.id)),
    ).toHaveLength(1);
  });
});
