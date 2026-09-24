import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schema } from "@pubrick/db";
import { eq } from "drizzle-orm";
import { XMLParser, XMLValidator } from "fast-xml-parser";
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
});
