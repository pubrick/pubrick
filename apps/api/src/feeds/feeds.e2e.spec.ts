import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schema } from "@pubrick/db";
import { eq } from "drizzle-orm";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import sharp from "sharp";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("public syndication feed", () => {
  let app: INestApplication;
  let db: typeof import("../db").db;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const [{ AppModule }, database] = await Promise.all([import("../app.module"), import("../db")]);
    db = database.db;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  async function member() {
    const agent = request.agent(app.getHttpServer());
    const unique = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `feed-${unique}@example.com`, password: "password1234", name: "Editor" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Feed org ${unique}`, slug: `feed-${unique}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    const brand = await agent.post("/api/brands").send({ name: "News & Notes" }).expect(201);
    return { agent, orgId: org.body.id as string, brandId: brand.body.id as string };
  }

  it("requires explicit inclusion, serves valid escaped XML and a real article, and revokes on disable", async () => {
    const owner = await member();
    const stranger = await member();
    const path = `/api/brands/${owner.brandId}/feed`;

    const disabled = await owner.agent.get(path).expect(200);
    expect(disabled.body).toEqual({ enabled: false, url: null, entries: [] });
    await stranger.agent.post(path).expect(404);

    const enabled = await owner.agent.post(path).expect(201);
    await stranger.agent.get(path).expect(404);
    const feedUrl = new URL(enabled.body.url as string);
    expect(feedUrl.pathname).toMatch(new RegExp(`^/api/feeds/${owner.orgId}/[^/]+/rss$`));
    const publicPath = feedUrl.pathname;
    const empty = await request(app.getHttpServer()).get(publicPath).expect(200);
    expect(empty.text).not.toContain("<item>");
    await request(app.getHttpServer())
      .get(publicPath.replace(owner.orgId, stranger.orgId))
      .expect(404);

    const liveRows = await db
      .insert(schema.contentItems)
      .values({
        orgId: owner.orgId,
        brandId: owner.brandId,
        status: "published",
        title: 'A & <B> "]]> story',
        body: "First <script>alert(1)</script> & line\n\nSecond ]]> paragraph\u0001",
      })
      .returning({ id: schema.contentItems.id });
    const draftRows = await db
      .insert(schema.contentItems)
      .values({
        orgId: owner.orgId,
        brandId: owner.brandId,
        title: "Private draft",
        body: "Secret",
      })
      .returning({ id: schema.contentItems.id });
    const live = liveRows[0];
    const draft = draftRows[0];
    if (!live || !draft) throw new Error("Feed test fixtures were not inserted");

    await owner.agent.post(`${path}/items/${draft.id}`).expect(400);
    await stranger.agent.post(`${path}/items/${live.id}`).expect(404);
    const added = await owner.agent.post(`${path}/items/${live.id}`).expect(201);
    expect(added.body.entries).toHaveLength(1);
    await owner.agent.post(`${path}/items/${live.id}`).expect(201);
    expect((await owner.agent.get(path)).body.entries).toHaveLength(1);

    const rss = await request(app.getHttpServer()).get(publicPath).expect(200);
    expect(rss.headers["content-type"]).toMatch(/^application\/rss\+xml/);
    expect(XMLValidator.validate(rss.text)).toBe(true);
    expect(rss.text).not.toContain("\u0001");
    const parsed = new XMLParser({ ignoreAttributes: false }).parse(rss.text);
    const item = parsed.rss.channel.item;
    expect(item.title).toBe('A & <B> "]]> story');
    expect(item.link).toMatch(/\/api\/feeds\/.*\/articles\//);
    expect(rss.text).not.toContain("Private draft");

    const articlePath = new URL(item.link).pathname;
    const article = await request(app.getHttpServer()).get(articlePath).expect(200);
    expect(article.text).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(article.text).not.toContain("<script>");

    await owner.agent.delete(`${path}/items/${live.id}`).expect(200);
    await request(app.getHttpServer()).get(articlePath).expect(404);
    const afterRemoval = await request(app.getHttpServer()).get(publicPath).expect(200);
    expect(afterRemoval.text).not.toContain("<item>");
    await owner.agent.post(`${path}/items/${live.id}`).expect(201);

    await owner.agent.delete(path).expect(200);
    await request(app.getHttpServer()).get(publicPath).expect(404);
    await request(app.getHttpServer()).get(articlePath).expect(404);
    const renewed = await owner.agent.post(path).expect(201);
    expect(renewed.body.url).not.toBe(enabled.body.url);
    expect(renewed.body.entries).toEqual([]);
    await db.delete(schema.contentItems).where(eq(schema.contentItems.id, live.id));
  });

  it("snapshots inline images, serves only included images, and revokes public access", async () => {
    const owner = await member();
    const stranger = await member();
    const feed = await owner.agent.post(`/api/brands/${owner.brandId}/feed`).expect(201);
    const base = new URL(feed.body.url as string).pathname.replace(/\/rss$/, "");
    const image = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#bf5930" },
    })
      .png()
      .toBuffer();
    const upload = await owner.agent
      .post(`/api/media?brandId=${owner.brandId}`)
      .attach("file", image, { filename: "figure.png", contentType: "image/png" })
      .expect(201);
    await owner.agent.get(`/api/media/${upload.body.id}/file`).expect(200);
    const item = await db
      .insert(schema.contentItems)
      .values({
        orgId: owner.orgId,
        brandId: owner.brandId,
        status: "published",
        title: "Illustrated article",
        body: "First paragraph\n\nSecond paragraph",
      })
      .returning({ id: schema.contentItems.id });
    if (!item[0]) throw new Error("Content fixture was not inserted");
    const itemId = item[0].id;
    const slot = await db
      .insert(schema.contentImageSlots)
      .values({
        orgId: owner.orgId,
        brandId: owner.brandId,
        contentItemId: itemId,
        mediaId: upload.body.id as string,
        afterParagraph: 0,
        alt: 'A "copper" square',
        caption: "Caption <script>unsafe</script>",
        alignment: "right",
      })
      .returning({ id: schema.contentImageSlots.id });

    await owner.agent.post(`/api/brands/${owner.brandId}/feed/items/${itemId}`).expect(201);
    const rss = await request(app.getHttpServer()).get(`${base}/rss`).expect(200);
    expect(XMLValidator.validate(rss.text)).toBe(true);
    expect(rss.text).toContain("/images/");
    const entry = new XMLParser({ ignoreAttributes: false }).parse(rss.text).rss.channel.item;
    const articlePath = new URL(entry.link as string).pathname;
    const article = await request(app.getHttpServer()).get(articlePath).expect(200);
    expect(article.text).toContain('alt="A &quot;copper&quot; square"');
    expect(article.text).toContain('style="max-width:32rem;margin:1.5rem 0 1.5rem auto"');
    expect(rss.text).toContain("1.5rem 0 1.5rem auto");
    expect(article.text).toContain("Caption &lt;script&gt;unsafe&lt;/script&gt;");
    expect(article.text).not.toContain("<script>");
    expect(article.text.indexOf("First paragraph")).toBeLessThan(article.text.indexOf("<figure "));
    expect(article.text.indexOf("<figure ")).toBeLessThan(article.text.indexOf("Second paragraph"));
    const imagePath = /src="([^"]+\/images\/[^/"]+)"/.exec(article.text)?.[1];
    if (!imagePath) throw new Error("Public article did not include its image");
    const publicImagePath = new URL(imagePath).pathname;
    const binary = await request(app.getHttpServer()).get(publicImagePath).expect(200);
    expect(binary.headers["content-type"]).toMatch(/^image\/jpeg/);
    expect(binary.headers["x-content-type-options"]).toBe("nosniff");
    await request(app.getHttpServer())
      .get(publicImagePath.replace(owner.orgId, stranger.orgId))
      .expect(404);

    if (!slot[0]) throw new Error("Image slot fixture was not inserted");
    await db.delete(schema.contentImageSlots).where(eq(schema.contentImageSlots.id, slot[0].id));
    const unchanged = await request(app.getHttpServer()).get(articlePath).expect(200);
    expect(unchanged.text).toContain(publicImagePath);
    expect(unchanged.text).toContain('style="max-width:32rem;margin:1.5rem 0 1.5rem auto"');
    await owner.agent.delete(`/api/media/${upload.body.id}`).expect(409);
    await owner.agent.delete(`/api/brands/${owner.brandId}/feed/items/${itemId}`).expect(200);
    await request(app.getHttpServer()).get(publicImagePath).expect(404);
    await owner.agent.delete(`/api/media/${upload.body.id}`).expect(204);
  });

  it("hands off only an approved Dzen adaptation, snapshots its text, and revokes it on rejection", async () => {
    const owner = await member();
    const stranger = await member();
    const feedPath = `/api/brands/${owner.brandId}/feed`;
    const channel = await owner.agent
      .post("/api/channels")
      .send({ brandId: owner.brandId, platform: "dzen", name: "Dzen" })
      .expect(201);
    const item = await owner.agent
      .post("/api/content")
      .send({
        brandId: owner.brandId,
        title: "Reviewed Dzen headline",
        body: "Master article text",
        channelIds: [channel.body.id],
      })
      .expect(201);
    const itemId = item.body.id as string;
    const adaptationId = item.body.adaptations[0].id as string;
    const handoffPath = `${feedPath}/adaptations/${adaptationId}`;
    await owner.agent
      .patch(`/api/content/${itemId}/adaptations/${adaptationId}`)
      .send({ body: "Dzen-specific copy" })
      .expect(200);

    await owner.agent.post(handoffPath).expect(404);
    const feed = await owner.agent.post(feedPath).expect(201);
    const rssPath = new URL(feed.body.url as string).pathname;
    await owner.agent.post(handoffPath).expect(400);
    await stranger.agent.post(handoffPath).expect(404);
    const otherBrand = await owner.agent
      .post("/api/brands")
      .send({ name: "Another brand" })
      .expect(201);
    await owner.agent.post(`/api/brands/${otherBrand.body.id}/feed`).expect(201);
    await owner.agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
    await owner.agent
      .post(`/api/brands/${otherBrand.body.id}/feed/adaptations/${adaptationId}`)
      .expect(400);
    const vc = await owner.agent
      .post("/api/channels")
      .send({ brandId: otherBrand.body.id, platform: "vc_ru", name: "VC.ru" })
      .expect(201);
    const vcItem = await owner.agent
      .post("/api/content")
      .send({
        brandId: otherBrand.body.id,
        title: "Another approved post",
        body: "VC body",
        channelIds: [vc.body.id],
      })
      .expect(201);
    await owner.agent.post(`/api/content/${vcItem.body.id}/approve`).send({}).expect(200);
    await owner.agent
      .post(`/api/brands/${otherBrand.body.id}/feed/adaptations/${vcItem.body.adaptations[0].id}`)
      .expect(400);

    const added = await owner.agent.post(handoffPath).expect(201);
    expect(added.body.entries).toMatchObject([{ contentItemId: itemId, adaptationId }]);
    const publicRss = await request(app.getHttpServer()).get(rssPath).expect(200);
    expect(publicRss.text).toContain("Dzen-specific copy");
    expect(publicRss.text).not.toContain("Master article text");
    const articleUrl = new XMLParser({ ignoreAttributes: false }).parse(publicRss.text).rss.channel
      .item.link as string;
    const articlePath = new URL(articleUrl).pathname;
    expect((await request(app.getHttpServer()).get(articlePath).expect(200)).text).toContain(
      "Dzen-specific copy",
    );
    const [snapshot] = await db
      .select({ id: schema.feedEntries.id, body: schema.feedEntries.body })
      .from(schema.feedEntries)
      .where(eq(schema.feedEntries.adaptationId, adaptationId));
    expect(snapshot?.body).toBe("Dzen-specific copy");
    await owner.agent.post(handoffPath).expect(201);
    expect((await owner.agent.get(feedPath).expect(200)).body.entries).toHaveLength(1);
    expect(
      await db
        .select({ id: schema.publications.id })
        .from(schema.publications)
        .where(eq(schema.publications.adaptationId, adaptationId)),
    ).toHaveLength(0);

    // Manual-ready delivery is considered started: retraction must refuse,
    // leaving the approved snapshot intact until a valid rejection removes it.
    await owner.agent.post(`/api/content/${itemId}/retract-approval`).expect(409);
    await request(app.getHttpServer()).get(articlePath).expect(200);

    await owner.agent.post(`/api/content/${itemId}/reject`).expect(200);
    expect((await owner.agent.get(feedPath).expect(200)).body.entries).toEqual([]);
    await request(app.getHttpServer()).get(articlePath).expect(404);
    expect((await request(app.getHttpServer()).get(rssPath).expect(200)).text).not.toContain(
      "Dzen-specific copy",
    );
    await owner.agent.post(handoffPath).expect(400);
    await owner.agent.post(`/api/content/${itemId}/approve`).send({}).expect(200);
    await owner.agent.post(handoffPath).expect(201);
    const secondRss = await request(app.getHttpServer()).get(rssPath).expect(200);
    const secondArticle = new URL(
      new XMLParser({ ignoreAttributes: false }).parse(secondRss.text).rss.channel.item
        .link as string,
    ).pathname;
    await owner.agent.delete(`/api/channels/${channel.body.id}`).expect(200);
    expect((await owner.agent.get(feedPath).expect(200)).body.entries).toEqual([]);
    await request(app.getHttpServer()).get(secondArticle).expect(404);
    await owner.agent.delete(feedPath).expect(200);
    await request(app.getHttpServer()).get(rssPath).expect(404);
  });
});
