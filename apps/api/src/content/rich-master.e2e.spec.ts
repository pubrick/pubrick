import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schema } from "@pubrick/db";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("rich master backend", () => {
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
    await app?.close();
  });

  it("checks CAS, keeps formatting-only history, clears stale rich text and snapshots a public article", async () => {
    const agent = request.agent(app.getHttpServer());
    const unique = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `rich-${unique}@example.com`, password: "password1234", name: "Editor" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: "Rich org", slug: `rich-${unique}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    const brand = await agent.post("/api/brands").send({ name: "Rich brand" }).expect(201);
    const [item] = await db
      .insert(schema.contentItems)
      .values({
        orgId: org.body.id,
        brandId: brand.body.id,
        title: "Public article",
        body: "A <b>tag</b>",
        origin: "ai",
      })
      .returning({ id: schema.contentItems.id });
    await db.insert(schema.contentVersions).values({
      orgId: org.body.id,
      contentItemId: item?.id ?? "",
      body: "A <b>tag</b>",
      origin: "ai",
    });
    const path = `/api/content/${item?.id}`;
    const rich = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "A <b>tag</b>", marks: [{ type: "bold" }] }],
        },
      ],
    };

    const saved = await agent
      .patch(path)
      .send({
        body: "A <b>tag</b>",
        richBody: rich,
        expectedBody: "A <b>tag</b>",
        expectedBodyRevision: 0,
      })
      .expect(200);
    expect(saved.body.richBody).toEqual(rich);
    expect(saved.body.bodyRevision).toBe(1);
    expect(saved.body.bodyIsAiVerbatim).toBe(true);
    expect(saved.body.richBodyHtml).toContain("<strong>A &lt;b&gt;tag&lt;/b&gt;</strong>");
    const versions = await agent.get(`${path}/versions`).expect(200);
    expect(versions.body[0].richBody).toEqual(rich);
    expect(versions.body[0].origin).toBe("human");

    const stale = await agent
      .patch(path)
      .send({
        body: "A <b>tag</b>",
        richBody: rich,
        expectedBody: "A <b>tag</b>",
        expectedBodyRevision: 0,
      })
      .expect(409);
    expect(stale.body.bodyRevision).toBe(1);
    const unchanged = await agent.patch(path).send({ body: "A <b>tag</b>" }).expect(200);
    expect(unchanged.body.richBody).toEqual(rich);
    expect(unchanged.body.bodyRevision).toBe(1);
    const changed = await agent.patch(path).send({ body: "After" }).expect(200);
    expect(changed.body.richBody).toBeNull();
    expect(changed.body.bodyRevision).toBe(2);

    const restored = await agent
      .post(`${path}/versions/${versions.body[0].id}/restore`)
      .send({ expectedBody: "After", expectedBodyRevision: 2 })
      .expect(200);
    expect(restored.body.richBody).toEqual(rich);
    expect(restored.body.bodyRevision).toBe(3);

    const textVersion = (await agent.get(`${path}/versions`).expect(200)).body.find(
      (version: { body: string; richBody: unknown }) =>
        version.body === "After" && version.richBody === null,
    );
    const plain = await agent
      .post(`${path}/versions/${textVersion.id}/restore`)
      .send({ expectedBody: "A <b>tag</b>", expectedBodyRevision: 3 })
      .expect(200);
    expect(plain.body.richBody).toBeNull();
    expect(plain.body.bodyRevision).toBe(4);
    const again = await agent
      .post(`${path}/versions/${versions.body[0].id}/restore`)
      .send({ expectedBody: "After", expectedBodyRevision: 4 })
      .expect(200);
    expect(again.body.richBody).toEqual(rich);
    expect(again.body.bodyRevision).toBe(5);

    await db
      .update(schema.contentItems)
      .set({ status: "published" })
      .where(eq(schema.contentItems.id, item?.id ?? ""));
    const feed = await agent.post(`/api/brands/${brand.body.id}/feed`).expect(201);
    await agent.post(`/api/brands/${brand.body.id}/feed/items/${item?.id}`).expect(201);
    const publicBase = new URL(feed.body.url as string).pathname.replace(/\/rss$/, "");
    const rss = await request(app.getHttpServer()).get(`${publicBase}/rss`).expect(200);
    expect(rss.text).toContain("&lt;b&gt;tag&lt;/b&gt;");
    const feedRow = await db
      .select({ id: schema.feedEntries.id })
      .from(schema.feedEntries)
      .where(eq(schema.feedEntries.contentItemId, item?.id ?? ""));
    const articlePath = `${publicBase}/articles/${feedRow[0]?.id}`;
    const article = await request(app.getHttpServer()).get(articlePath).expect(200);
    expect(article.text).toContain("<strong>A &lt;b&gt;tag&lt;/b&gt;</strong>");
    expect(article.text).not.toContain("<b>tag</b>");
    await db
      .update(schema.contentItems)
      .set({ body: "Later" })
      .where(eq(schema.contentItems.id, item?.id ?? ""));
    const [latest] = await db
      .select({
        richBody: schema.contentItems.richBody,
        bodyRevision: schema.contentItems.bodyRevision,
      })
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, item?.id ?? ""));
    expect(latest).toEqual({ richBody: null, bodyRevision: 6 });
    expect((await request(app.getHttpServer()).get(articlePath).expect(200)).text).toContain(
      "<strong>A &lt;b&gt;tag&lt;/b&gt;</strong>",
    );
  });
});
