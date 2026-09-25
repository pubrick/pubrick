import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schema } from "@pubrick/db";
import { topicDtoSchema } from "@pubrick/shared";
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("topic bank e2e", () => {
  let app: INestApplication;
  let db: typeof import("../db")["db"];

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    db = (await import("../db")).db;
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  async function orgAgent() {
    const agent = request.agent(app.getHttpServer());
    const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `topics${uniq}@example.com`, password: "password1234", name: "U" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${uniq}`, slug: `topics-org-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return { agent, orgId: org.body.id as string };
  }

  it("scopes topics and feedback, imports news once, and runs only approved topics", async () => {
    const owner = await orgAgent();
    const other = await orgAgent();
    const brand = await owner.agent.post("/api/brands").send({ name: "Newsroom" }).expect(201);
    const second = await owner.agent.post("/api/brands").send({ name: "Second" }).expect(201);
    const channel = await owner.agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Main",
        credentials: { botToken: "123:abc", chatId: "@pubrick" },
      })
      .expect(201);
    const source = await db
      .insert(schema.newsSources)
      .values({
        orgId: owner.orgId,
        brandId: brand.body.id,
        name: "Journal",
        url: "https://example.com/feed.xml",
      })
      .returning({ id: schema.newsSources.id });
    if (!source[0]) throw new Error("Source insert returned no row");
    const news = await db
      .insert(schema.newsItems)
      .values({
        orgId: owner.orgId,
        brandId: brand.body.id,
        sourceId: source[0].id,
        title: "A new market hall",
        summary: "The council approved it.",
        url: "https://example.com/market-hall",
      })
      .returning({ id: schema.newsItems.id });
    if (!news[0]) throw new Error("Article insert returned no row");
    const itemId = news[0].id;

    await other.agent.get(`/api/topics?brandId=${brand.body.id}`).expect(404);
    await owner.agent.get(`/api/topics?brandId=${second.body.id}`).expect(200, []);
    await owner.agent.post(`/api/topics/from-news/${itemId}?brandId=${second.body.id}`).expect(404);
    await other.agent.post(`/api/topics/from-news/${itemId}?brandId=${brand.body.id}`).expect(404);

    const saved = await owner.agent
      .post(`/api/topics/from-news/${itemId}?brandId=${brand.body.id}`)
      .expect(201);
    expect(topicDtoSchema.parse(saved.body)).toMatchObject({
      title: "A new market hall",
      description: "The council approved it.",
      status: "idea",
      newsItemId: itemId,
    });
    await expect(
      db.execute(sql`update topics set status = 'apprved' where id = ${saved.body.id}`),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      db.execute(sql`update news_items set editor_signal = 'unknown' where id = ${itemId}`),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    const again = await owner.agent
      .post(`/api/topics/from-news/${itemId}?brandId=${brand.body.id}`)
      .expect(201);
    expect(again.body.id).toBe(saved.body.id);
    const unapproved = await owner.agent
      .post(`/api/topics/${saved.body.id}/run?brandId=${brand.body.id}`)
      .send({ channelIds: [channel.body.id] })
      .expect(409);
    expect(unapproved.body.code).toBe("topic_not_approved");

    await owner.agent
      .patch(`/api/topics/news/${itemId}/feedback?brandId=${second.body.id}`)
      .send({ signal: "relevant" })
      .expect(404);
    await other.agent
      .patch(`/api/topics/news/${itemId}/feedback?brandId=${brand.body.id}`)
      .send({ signal: "relevant" })
      .expect(404);
    await owner.agent
      .patch(`/api/topics/news/${itemId}/feedback?brandId=${brand.body.id}`)
      .send({ signal: "relevant" })
      .expect(200);
    expect(
      (await owner.agent.get(`/api/sources/items?brandId=${brand.body.id}`).expect(200)).body[0],
    ).toMatchObject({ editorSignal: "relevant" });

    await owner.agent
      .patch(`/api/topics/${saved.body.id}?brandId=${second.body.id}`)
      .send({ status: "approved" })
      .expect(404);
    await other.agent.delete(`/api/topics/${saved.body.id}?brandId=${brand.body.id}`).expect(404);
    await owner.agent
      .patch(`/api/topics/${saved.body.id}?brandId=${brand.body.id}`)
      .send({ title: "Market hall opening" })
      .expect(200);
    await owner.agent
      .patch(`/api/topics/${saved.body.id}?brandId=${brand.body.id}`)
      .send({ status: "approved" })
      .expect(200);
    const run = await owner.agent
      .post(`/api/topics/${saved.body.id}/run?brandId=${brand.body.id}`)
      .send({ channelIds: [channel.body.id] })
      .expect(201);
    expect(run.body.input).toMatchObject({
      kind: "source",
      sourceUrl: "https://example.com/market-hall",
      material: "Market hall opening\n\nThe council approved it.",
    });
    await owner.agent
      .post(`/api/topics/${saved.body.id}/run?brandId=${brand.body.id}`)
      .send({ channelIds: [channel.body.id], seoKeywords: ["local market hall"] })
      .expect(400);
    const expertRun = await owner.agent
      .post(`/api/topics/${saved.body.id}/run?brandId=${brand.body.id}`)
      .send({
        channelIds: [channel.body.id],
        contentType: "expert_article",
        seoKeywords: ["local market hall"],
      })
      .expect(201);
    expect(expertRun.body.input).toMatchObject({
      contentType: "expert_article",
      seoKeywords: ["local market hall"],
    });
    const edited = await owner.agent
      .patch(`/api/topics/${saved.body.id}?brandId=${brand.body.id}`)
      .send({ title: "Revised market hall" })
      .expect(200);
    expect(edited.body.status).toBe("idea");
    const combined = await owner.agent
      .patch(`/api/topics/${saved.body.id}?brandId=${brand.body.id}`)
      .send({ title: "Final market hall", status: "approved" })
      .expect(200);
    expect(combined.body.status).toBe("idea");
    await owner.agent
      .post(`/api/topics/${saved.body.id}/run?brandId=${brand.body.id}`)
      .send({ channelIds: [channel.body.id] })
      .expect(409);
    await owner.agent
      .patch(`/api/topics/${saved.body.id}?brandId=${brand.body.id}`)
      .send({ status: "archived" })
      .expect(200);
    await owner.agent
      .post(`/api/topics/${saved.body.id}/run?brandId=${brand.body.id}`)
      .send({ channelIds: [channel.body.id] })
      .expect(409);
    await owner.agent.delete(`/api/topics/${saved.body.id}?brandId=${brand.body.id}`).expect(200);
    expect(
      (await owner.agent.get(`/api/topics?brandId=${brand.body.id}`).expect(200)).body,
    ).toEqual([]);
    await owner.agent.get(`/api/runs/${run.body.id}`).expect(200);
  });

  it("queues one brand-scoped suggestion request and reuses it during the cooldown", async () => {
    const owner = await orgAgent();
    const other = await orgAgent();
    const brand = await owner.agent.post("/api/brands").send({ name: "Ideas" }).expect(201);
    await other.agent.get(`/api/topics/suggestions?brandId=${brand.body.id}`).expect(404);
    await other.agent.post(`/api/topics/suggestions?brandId=${brand.body.id}`).expect(404);
    expect(
      (await owner.agent.get(`/api/topics/suggestions?brandId=${brand.body.id}`).expect(200)).body,
    ).toEqual({ request: null });
    const first = await owner.agent
      .post(`/api/topics/suggestions?brandId=${brand.body.id}`)
      .expect(201);
    expect(first.body).toMatchObject({
      brandId: brand.body.id,
      status: "queued",
      suggestionCount: 0,
    });
    const again = await owner.agent
      .post(`/api/topics/suggestions?brandId=${brand.body.id}`)
      .expect(201);
    expect(again.body.id).toBe(first.body.id);
    expect(
      (await owner.agent.get(`/api/topics/suggestions?brandId=${brand.body.id}`).expect(200)).body
        .request.id,
    ).toBe(first.body.id);
    expect(
      (await owner.agent.get(`/api/topics?brandId=${brand.body.id}`).expect(200)).body,
    ).toEqual([]);
  });

  it("scopes dated topic plans and keeps approval when only date or priority changes", async () => {
    const owner = await orgAgent();
    const other = await orgAgent();
    const brand = await owner.agent.post("/api/brands").send({ name: "Planning" }).expect(201);
    const created = await owner.agent
      .post("/api/topics")
      .send({
        brandId: brand.body.id,
        title: "Autumn collection",
        plannedDate: "2026-10-11",
        priority: 9,
      })
      .expect(201);
    expect(topicDtoSchema.parse(created.body)).toMatchObject({
      plannedDate: "2026-10-11",
      priority: 9,
      revision: 1,
    });
    const path = `/api/topics/${created.body.id}?brandId=${brand.body.id}`;
    await other.agent.get(`/api/topics?brandId=${brand.body.id}`).expect(404);
    await other.agent.patch(path).send({ plannedDate: "2026-10-12" }).expect(404);
    await owner.agent.patch(path).send({ plannedDate: "2026-02-30" }).expect(400);
    await owner.agent.patch(path).send({ priority: 11 }).expect(400);
    const approved = await owner.agent.patch(path).send({ status: "approved" }).expect(200);
    expect(approved.body.revision).toBe(2);
    const rescheduled = await owner.agent
      .patch(path)
      .send({ plannedDate: "2026-10-12", priority: 1 })
      .expect(200);
    expect(topicDtoSchema.parse(rescheduled.body)).toMatchObject({
      status: "approved",
      plannedDate: "2026-10-12",
      priority: 1,
      revision: 3,
    });
    expect(
      (await owner.agent.get(`/api/topics?brandId=${brand.body.id}`).expect(200)).body[0],
    ).toMatchObject({
      plannedDate: "2026-10-12",
      priority: 1,
    });
    const cleared = await owner.agent.patch(path).send({ plannedDate: null }).expect(200);
    expect(cleared.body).toMatchObject({ plannedDate: null, status: "approved", revision: 4 });
    const changedBrief = await owner.agent
      .patch(path)
      .send({ title: "Winter collection" })
      .expect(200);
    expect(changedBrief.body).toMatchObject({ status: "idea", priority: 1, revision: 5 });
    await expect(
      db.execute(sql`update topics set priority = 0 where id = ${created.body.id}`),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });
});
