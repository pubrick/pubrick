import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schema } from "@pubrick/db";
import {
  topicDtoSchema,
  topicSuggestionHistoryPageSchema,
  topicSuggestionScanDecisionsSchema,
} from "@pubrick/shared";
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
    const signUp = await agent
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
    return { agent, orgId: org.body.id as string, userId: signUp.body.user.id as string };
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
    expect(
      (await owner.agent.get(`/api/sources/items?brandId=${brand.body.id}`).expect(200)).body[0],
    ).toMatchObject({ editorSignal: "relevant" });
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
    await owner.agent
      .post(`/api/sources/items/${itemId}/dismiss?brandId=${brand.body.id}`)
      .expect(201);
    const hiddenConversion = await owner.agent
      .post(`/api/topics/from-news/${itemId}?brandId=${brand.body.id}`)
      .expect(409);
    expect(hiddenConversion.body.code).toBe("news_item_dismissed");
    await owner.agent
      .post(`/api/sources/items/${itemId}/restore?brandId=${brand.body.id}`)
      .expect(201);
    const afterRestore = await owner.agent
      .post(`/api/topics/from-news/${itemId}?brandId=${brand.body.id}`)
      .expect(201);
    expect(afterRestore.body.id).toBe(saved.body.id);
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

  it("lists bounded suggestion history by stable cursor within one brand", async () => {
    const owner = await orgAgent();
    const other = await orgAgent();
    const brand = await owner.agent.post("/api/brands").send({ name: "Ideas" }).expect(201);
    const sibling = await owner.agent.post("/api/brands").send({ name: "Other ideas" }).expect(201);
    const idPrefix = randomUUID().slice(0, 8);
    const ids = [1, 2, 3, 4].map(
      (n) => `${idPrefix}-0000-4000-8000-${String(n).padStart(12, "0")}`,
    );
    const sameTime = new Date("2026-09-23T12:00:00.000Z");
    await db.insert(schema.topicSuggestionRequests).values([
      {
        id: ids[0],
        orgId: owner.orgId,
        brandId: brand.body.id,
        origin: "manual",
        status: "failed",
        errorCode: "model_failed",
        createdAt: new Date("2026-09-22T12:00:00.000Z"),
      },
      {
        id: ids[1],
        orgId: owner.orgId,
        brandId: brand.body.id,
        origin: "automatic",
        localDate: "2026-09-23",
        status: "succeeded",
        suggestionCount: 2,
        createdAt: sameTime,
      },
      {
        id: ids[2],
        orgId: owner.orgId,
        brandId: brand.body.id,
        origin: "manual",
        status: "running",
        createdAt: sameTime,
      },
      {
        id: ids[3],
        orgId: owner.orgId,
        brandId: brand.body.id,
        origin: "automatic",
        localDate: "2026-09-24",
        status: "queued",
        createdAt: new Date("2026-09-24T12:00:00.000Z"),
      },
    ]);
    const [foreign] = await db
      .insert(schema.topicSuggestionRequests)
      .values({
        orgId: owner.orgId,
        brandId: sibling.body.id,
        origin: "manual",
      })
      .returning({ id: schema.topicSuggestionRequests.id });
    if (!foreign) throw new Error("Foreign suggestion seed failed");
    const base = `/api/topics/suggestions/history?brandId=${brand.body.id}`;
    const endpoint = `${base}&limit=2`;
    await other.agent.get(endpoint).expect(404);
    await owner.agent.get(`${endpoint}&cursor=${foreign.id}`).expect(400);
    await owner.agent.get(`${base}&limit=0`).expect(400);
    const first = topicSuggestionHistoryPageSchema.parse(
      (await owner.agent.get(endpoint).expect(200)).body,
    );
    expect(first.rows.map((row) => row.id)).toEqual([ids[3], ids[2]]);
    expect(first.rows[0]).toMatchObject({
      origin: "automatic",
      localDate: "2026-09-24",
      status: "queued",
    });
    expect(first.nextCursor).toBe(ids[2]);
    const second = topicSuggestionHistoryPageSchema.parse(
      (await owner.agent.get(`${endpoint}&cursor=${first.nextCursor}`).expect(200)).body,
    );
    expect(second.rows.map((row) => row.id)).toEqual([ids[1], ids[0]]);
    expect(second.rows[0]).toMatchObject({ origin: "automatic", suggestionCount: 2 });
    expect(second.rows[1]).toMatchObject({ errorCode: "model_failed" });
    expect(second.nextCursor).toBeNull();
  });

  it("lists only the brand's recent skipped daily scans, excluding queued requests", async () => {
    const owner = await orgAgent();
    const other = await orgAgent();
    const brand = await owner.agent.post("/api/brands").send({ name: "Daily ideas" }).expect(201);
    const sibling = await owner.agent.post("/api/brands").send({ name: "Sibling" }).expect(201);
    await db.insert(schema.topicSuggestionScanDecisions).values(
      Array.from({ length: 22 }, (_, index) => ({
        orgId: owner.orgId,
        brandId: brand.body.id,
        localDate: `2026-09-${String(index + 1).padStart(2, "0")}`,
        decision: index % 2 ? ("ideas_pending" as const) : ("no_ai_key" as const),
      })),
    );
    await db.insert(schema.topicSuggestionScanDecisions).values({
      orgId: owner.orgId,
      brandId: sibling.body.id,
      localDate: "2026-09-23",
      decision: "no_ai_key",
    });
    const [request] = await db
      .insert(schema.topicSuggestionRequests)
      .values({
        orgId: owner.orgId,
        brandId: brand.body.id,
        origin: "automatic",
        localDate: "2026-09-23",
      })
      .returning({ id: schema.topicSuggestionRequests.id });
    await db.insert(schema.topicSuggestionScanDecisions).values({
      orgId: owner.orgId,
      brandId: brand.body.id,
      localDate: "2026-09-23",
      decision: "queued",
      requestId: request?.id,
    });
    const endpoint = `/api/topics/suggestions/scan-decisions?brandId=${brand.body.id}`;
    await other.agent.get(endpoint).expect(404);
    await owner.agent.get("/api/topics/suggestions/scan-decisions?brandId=invalid").expect(400);
    const rows = topicSuggestionScanDecisionsSchema.parse(
      (await owner.agent.get(endpoint).expect(200)).body,
    );
    expect(rows).toHaveLength(20);
    expect(rows[0]).toMatchObject({ localDate: "2026-09-22", decision: "ideas_pending" });
    expect(rows.at(-1)?.localDate).toBe("2026-09-03");
    expect(rows.every((row) => row.brandId === brand.body.id && row.decision !== "queued")).toBe(
      true,
    );
  });

  it("blocks an exact title as a durable tombstone until explicitly unblocked", async () => {
    const owner = await orgAgent();
    const other = await orgAgent();
    const editor = await orgAgent();
    const brand = await owner.agent.post("/api/brands").send({ name: "Editorial" }).expect(201);
    const second = await owner.agent.post("/api/brands").send({ name: "Other" }).expect(201);
    const topic = await owner.agent
      .post("/api/topics")
      .send({ brandId: brand.body.id, title: "Do not repeat this" })
      .expect(201);
    const path = `/api/topics/${topic.body.id}?brandId=${brand.body.id}`;
    const memberId = randomUUID();
    await db.insert(schema.member).values({
      id: memberId,
      organizationId: owner.orgId,
      userId: editor.userId,
      role: "member",
    });
    await editor.agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: owner.orgId })
      .expect(200);
    await editor.agent
      .post(`/api/topics/${topic.body.id}/block?brandId=${brand.body.id}`)
      .send({ reason: "Reviewed" })
      .expect(404);
    await db
      .insert(schema.brandAccess)
      .values({ orgId: owner.orgId, brandId: brand.body.id, memberId });
    await other.agent
      .post(`/api/topics/${topic.body.id}/block?brandId=${brand.body.id}`)
      .send({ reason: "Reviewed" })
      .expect(404);
    await owner.agent
      .post(`/api/topics/${topic.body.id}/block?brandId=${second.body.id}`)
      .send({ reason: "Reviewed" })
      .expect(404);
    await owner.agent
      .post(`/api/topics/${topic.body.id}/block?brandId=${brand.body.id}`)
      .send({ reason: " " })
      .expect(400);
    const blocked = await editor.agent
      .post(`/api/topics/${topic.body.id}/block?brandId=${brand.body.id}`)
      .send({ reason: "Outside editorial scope" })
      .expect(201);
    expect(topicDtoSchema.parse(blocked.body)).toMatchObject({
      status: "archived",
      blockReason: "Outside editorial scope",
      revision: topic.body.revision + 1,
    });
    expect(blocked.body.blockedAt).toBeTruthy();
    const again = await owner.agent
      .post(`/api/topics/${topic.body.id}/block?brandId=${brand.body.id}`)
      .send({ reason: "Changed reason" })
      .expect(201);
    expect(again.body).toEqual(blocked.body);
    await owner.agent.patch(path).send({ status: "approved" }).expect(409);
    await owner.agent.patch(path).send({ title: "Erase tombstone" }).expect(409);
    await owner.agent.delete(path).expect(409);
    await owner.agent
      .post(`/api/topics/${topic.body.id}/run?brandId=${brand.body.id}`)
      .send({ channelIds: [randomUUID()] })
      .expect(409);
    const runs = await db
      .select({ id: schema.pipelineRuns.id })
      .from(schema.pipelineRuns)
      .where(
        sql`${schema.pipelineRuns.orgId} = ${owner.orgId} and ${schema.pipelineRuns.brandId} = ${brand.body.id}`,
      );
    expect(runs).toEqual([]);
    const unblocked = await owner.agent
      .post(`/api/topics/${topic.body.id}/unblock?brandId=${brand.body.id}`)
      .expect(201);
    expect(unblocked.body).toMatchObject({
      status: "idea",
      blockedAt: null,
      blockReason: null,
      revision: topic.body.revision + 2,
    });
    const unblockedAgain = await owner.agent
      .post(`/api/topics/${topic.body.id}/unblock?brandId=${brand.body.id}`)
      .expect(201);
    expect(unblockedAgain.body).toEqual(unblocked.body);
    await owner.agent.patch(path).send({ status: "approved" }).expect(200);
  });

  it("saves a topic format and keywords, uses them for direct runs, and revokes approval on edits", async () => {
    const owner = await orgAgent();
    const other = await orgAgent();
    const brand = await owner.agent.post("/api/brands").send({ name: "Guides" }).expect(201);
    const channel = await owner.agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Main",
        credentials: { botToken: "123:abc", chatId: "@pubrick" },
      })
      .expect(201);
    const created = await owner.agent
      .post("/api/topics")
      .send({
        brandId: brand.body.id,
        title: "Neighborhood guide",
        contentType: "expert_article",
        seoKeywords: ["market guide"],
      })
      .expect(201);
    expect(topicDtoSchema.parse(created.body)).toMatchObject({
      contentType: "expert_article",
      seoKeywords: ["market guide"],
    });
    await expect(
      db.execute(sql`update topics set content_type = 'social_post' where id = ${created.body.id}`),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      db.execute(
        sql`update topics set content_type = 'case_study', seo_keywords = '[]'::jsonb where id = ${created.body.id}`,
      ),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await other.agent
      .patch(`/api/topics/${created.body.id}?brandId=${brand.body.id}`)
      .send({ seoKeywords: [] })
      .expect(404);
    await owner.agent
      .patch(`/api/topics/${created.body.id}?brandId=${brand.body.id}`)
      .send({ status: "approved" })
      .expect(200);
    const first = await owner.agent
      .post(`/api/topics/${created.body.id}/run?brandId=${brand.body.id}`)
      .send({ channelIds: [channel.body.id] })
      .expect(201);
    expect(first.body.input).toMatchObject({
      contentType: "expert_article",
      seoKeywords: ["market guide"],
    });
    const withoutSeo = await owner.agent
      .post(`/api/topics/${created.body.id}/run?brandId=${brand.body.id}`)
      .send({ channelIds: [channel.body.id], seoKeywords: [] })
      .expect(201);
    expect(withoutSeo.body.input.contentType).toBe("expert_article");
    expect(withoutSeo.body.input.seoKeywords).toBeUndefined();
    const edited = await owner.agent
      .patch(`/api/topics/${created.body.id}?brandId=${brand.body.id}`)
      .send({ seoKeywords: [] })
      .expect(200);
    expect(edited.body).toMatchObject({ status: "idea", seoKeywords: [] });
    expect(edited.body.revision).toBeGreaterThan(created.body.revision);
    await owner.agent
      .post(`/api/topics/${created.body.id}/run?brandId=${brand.body.id}`)
      .send({ channelIds: [channel.body.id] })
      .expect(409);
    await owner.agent
      .patch(`/api/topics/${created.body.id}?brandId=${brand.body.id}`)
      .send({ contentType: "social_post" })
      .expect(200);
    await owner.agent
      .patch(`/api/topics/${created.body.id}?brandId=${brand.body.id}`)
      .send({ status: "approved" })
      .expect(200);
    const second = await owner.agent
      .post(`/api/topics/${created.body.id}/run?brandId=${brand.body.id}`)
      .send({ channelIds: [channel.body.id] })
      .expect(201);
    expect(second.body.input.contentType).toBe("social_post");
    expect(second.body.input.seoKeywords).toBeUndefined();
  });

  it("refuses a direct run if the approved topic changes after its first read", async () => {
    const owner = await orgAgent();
    const brand = await owner.agent.post("/api/brands").send({ name: "Race guard" }).expect(201);
    const channel = await owner.agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Main",
        credentials: { botToken: "123:abc", chatId: "@pubrick" },
      })
      .expect(201);
    const topic = await owner.agent
      .post("/api/topics")
      .send({
        brandId: brand.body.id,
        title: "Reviewed",
        contentType: "expert_article",
        seoKeywords: ["first phrase"],
      })
      .expect(201);
    await owner.agent
      .patch(`/api/topics/${topic.body.id}?brandId=${brand.body.id}`)
      .send({ status: "approved" })
      .expect(200);
    const { TopicsRepository } = await import("./topics.repository");
    const repository = app.get(TopicsRepository);
    const originalGet = repository.get.bind(repository);
    let signalRead = () => {};
    let releaseRead = () => {};
    const read = new Promise<void>((resolve) => {
      signalRead = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    repository.get = async (orgId, brandId, id) => {
      const snapshot = await originalGet(orgId, brandId, id);
      signalRead();
      await release;
      return snapshot;
    };
    try {
      const pending = owner.agent
        .post(`/api/topics/${topic.body.id}/run?brandId=${brand.body.id}`)
        .send({ channelIds: [channel.body.id] });
      const result = pending.then((response) => response);
      await read;
      await owner.agent
        .patch(`/api/topics/${topic.body.id}?brandId=${brand.body.id}`)
        .send({ seoKeywords: ["second phrase"] })
        .expect(200);
      releaseRead();
      const response = await result;
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("topic_changed");
    } finally {
      releaseRead();
      repository.get = originalGet;
    }
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
