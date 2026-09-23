import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schema } from "@pubrick/db";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CommentAnalysisCaller } from "./comment-analysis.caller";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("watched sources e2e", () => {
  let app: INestApplication;
  const analysisRun = vi.fn();

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(CommentAnalysisCaller)
      .useValue({ run: analysisRun })
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  async function orgAgent(): Promise<{ agent: request.Agent; orgId: string }> {
    const agent = request.agent(app.getHttpServer());
    const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `rss${uniq}@example.com`, password: "password1234", name: "U" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${uniq}`, slug: `rss-org-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return { agent, orgId: org.body.id };
  }

  it("scopes feed CRUD and news reads by both organization and brand", async () => {
    const { agent: owner, orgId: ownerOrgId } = await orgAgent();
    const { agent: other } = await orgAgent();
    const a = await owner.post("/api/brands").send({ name: "Brand A" }).expect(201);
    const b = await owner.post("/api/brands").send({ name: "Brand B" }).expect(201);
    const source = await owner
      .post("/api/sources")
      .send({
        brandId: a.body.id,
        name: "Journal",
        url: "https://example.com/feed.xml",
      })
      .expect(201);
    expect(source.body).toMatchObject({ brandId: a.body.id, name: "Journal", isActive: true });
    expect(source.body.kind).toBe("rss");

    const telegram = await owner
      .post("/api/sources")
      .send({
        brandId: a.body.id,
        name: "Public channel",
        kind: "telegram",
        url: "https://t.me/example_channel",
      })
      .expect(201);
    expect(telegram.body).toMatchObject({ kind: "telegram", url: "https://t.me/example_channel" });
    await owner
      .post("/api/sources")
      .send({
        brandId: a.body.id,
        name: "Duplicate",
        kind: "telegram",
        url: "https://t.me/EXAMPLE_CHANNEL/",
      })
      .expect(409);
    await owner
      .post("/api/sources")
      .send({
        brandId: a.body.id,
        name: "Invalid",
        kind: "telegram",
        url: "https://evil.example.com/channel",
      })
      .expect(400);
    expect((await owner.get("/api/sources/telegram-connection").expect(200)).body).toEqual({
      connected: false,
    });
    expect((await other.get("/api/sources/telegram-connection").expect(200)).body).toEqual({
      connected: false,
    });
    const { db } = await import("../db");
    await db
      .insert(schema.telegramSourceAccounts)
      .values({ orgId: ownerOrgId, sessionEncrypted: "never-expose-this-session" });
    expect((await owner.get("/api/sources/telegram-connection").expect(200)).body).toEqual({
      connected: true,
    });
    expect((await other.get("/api/sources/telegram-connection").expect(200)).body).toEqual({
      connected: false,
    });
    await owner
      .patch(`/api/sources/${source.body.id}?brandId=${a.body.id}`)
      .send({ url: "https://example.com/updated.xml" })
      .expect(200);
    await owner
      .patch(`/api/sources/${telegram.body.id}?brandId=${a.body.id}`)
      .send({ url: "https://example.com/feed.xml" })
      .expect(400);

    const list = await owner.get(`/api/sources?brandId=${a.body.id}`).expect(200);
    expect(list.body.map((row: { id: string }) => row.id)).toContain(source.body.id);
    expect((await owner.get(`/api/sources?brandId=${b.body.id}`).expect(200)).body).toEqual([]);
    expect((await owner.get(`/api/sources/items?brandId=${a.body.id}`).expect(200)).body).toEqual(
      [],
    );
    const [telegramItem] = await db
      .insert(schema.newsItems)
      .values({
        orgId: ownerOrgId,
        brandId: a.body.id,
        sourceId: telegram.body.id,
        title: "Public story",
        summary: "A public Telegram story",
        url: "https://t.me/example_channel/42",
      })
      .returning({ id: schema.newsItems.id });
    if (!telegramItem) throw new Error("Telegram story fixture was not inserted");
    expect(
      (
        await owner
          .get(`/api/sources/items/${telegramItem.id}/comments?brandId=${a.body.id}`)
          .expect(200)
      ).body,
    ).toEqual([]);
    await other
      .get(`/api/sources/items/${telegramItem.id}/comments?brandId=${a.body.id}`)
      .expect(404);
    await owner
      .get(`/api/sources/items/${telegramItem.id}/comments?brandId=${b.body.id}`)
      .expect(404);
    expect(
      (
        await owner
          .post(`/api/sources/items/${telegramItem.id}/comments/refresh?brandId=${a.body.id}`)
          .expect(201)
      ).body,
    ).toEqual({ queued: true });
    const [queuedItem] = (await owner.get(`/api/sources/items?brandId=${a.body.id}`).expect(200))
      .body;
    expect(queuedItem).toMatchObject({
      id: telegramItem.id,
      commentsStatus: "pending",
      commentsCheckedAt: null,
      commentsErrorCode: null,
    });
    expect(
      (
        await owner
          .post(`/api/sources/items/${telegramItem.id}/comments/refresh?brandId=${a.body.id}`)
          .expect(201)
      ).body,
    ).toEqual({ queued: false });
    await owner
      .post(`/api/sources/items/${telegramItem.id}/comments/refresh?brandId=${b.body.id}`)
      .expect(404);
    await owner
      .patch(`/api/sources/${telegram.body.id}?brandId=${a.body.id}`)
      .send({ isActive: false })
      .expect(200);
    await owner
      .post(`/api/sources/items/${telegramItem.id}/comments/refresh?brandId=${a.body.id}`)
      .expect(409);
    await owner
      .patch(`/api/sources/${telegram.body.id}?brandId=${a.body.id}`)
      .send({ isActive: true })
      .expect(200);
    await other.get(`/api/sources?brandId=${a.body.id}`).expect(404);
    await other.get(`/api/sources/items?brandId=${a.body.id}`).expect(404);
    await other
      .patch(`/api/sources/${source.body.id}?brandId=${a.body.id}`)
      .send({ isActive: false })
      .expect(404);
    await owner
      .patch(`/api/sources/${source.body.id}?brandId=${b.body.id}`)
      .send({ isActive: false })
      .expect(404);
    await owner.delete(`/api/sources/${source.body.id}?brandId=${b.body.id}`).expect(404);
    await other.delete(`/api/sources/${source.body.id}?brandId=${a.body.id}`).expect(404);

    const refresh = await owner
      .post(`/api/sources/${source.body.id}/refresh?brandId=${a.body.id}`)
      .expect(201);
    expect(refresh.body).toEqual({ queued: false });
    await owner
      .patch(`/api/sources/${source.body.id}?brandId=${a.body.id}`)
      .send({ isActive: false })
      .expect(200);
    await owner.post(`/api/sources/${source.body.id}/refresh?brandId=${a.body.id}`).expect(409);
    await owner.delete(`/api/sources/${source.body.id}?brandId=${a.body.id}`).expect(200);
    await owner.delete(`/api/sources/${telegram.body.id}?brandId=${a.body.id}`).expect(200);
    expect((await owner.get(`/api/sources?brandId=${a.body.id}`).expect(200)).body).toEqual([]);
  });

  it("analyzes an organization-scoped saved sample, records spend, and marks later samples stale", async () => {
    const { agent, orgId } = await orgAgent();
    const { agent: other } = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Discussion brand" }).expect(201);
    const source = await agent
      .post("/api/sources")
      .send({
        brandId: brand.body.id,
        name: "Public channel",
        kind: "telegram",
        url: "https://t.me/discussion_fixture",
      })
      .expect(201);
    const { db } = await import("../db");
    const [item] = await db
      .insert(schema.newsItems)
      .values({
        orgId,
        brandId: brand.body.id,
        sourceId: source.body.id,
        title: "A public post",
        url: "https://t.me/discussion_fixture/7",
      })
      .returning({ id: schema.newsItems.id });
    if (!item) throw new Error("story fixture missing");
    const route = `/api/sources/items/${item.id}/comment-analysis?brandId=${brand.body.id}`;
    expect((await agent.get(route).expect(200)).body).toEqual({ status: "not_collected" });
    await other.get(route).expect(404);
    await other.post(route).expect(404);
    await db
      .update(schema.newsItems)
      .set({
        commentsStatus: "available",
        commentsCheckedAt: new Date("2026-09-23T10:00:00Z"),
      })
      .where(eq(schema.newsItems.id, item.id));
    expect((await agent.get(route).expect(200)).body).toEqual({ status: "no_comments" });
    await db.insert(schema.newsComments).values({
      orgId,
      brandId: brand.body.id,
      itemId: item.id,
      telegramMessageId: 10,
      body: "Please explain the pricing for smaller teams.",
      publishedAt: new Date("2026-09-23T09:00:00Z"),
    });
    expect((await agent.get(route).expect(200)).body).toEqual({ status: "no_key" });
    expect((await agent.post(route).expect(201)).body).toEqual({ status: "no_key" });
    expect(analysisRun).not.toHaveBeenCalled();
    await agent
      .put("/api/ai-credentials")
      .send({
        provider: "google",
        apiKey: "test-key-never-used",
      })
      .expect(200);
    expect((await agent.get(route).expect(200)).body).toEqual({ status: "not_analyzed" });
    analysisRun.mockResolvedValueOnce({
      ok: true,
      result: {
        summary: "Readers want clearer prices for small teams.",
        sentiment: { positive: 0, neutral: 1, negative: 0 },
        themes: [{ label: "Pricing", mentions: 1 }],
        feedback: ["Clarify the small-team pricing."],
      },
      usage: [
        {
          provider: "google",
          modelId: "gemini-test",
          attempt: 1,
          inputTokens: 20,
          outputTokens: 10,
          cachedInputTokens: 0,
          reasoningTokens: 0,
          costUsd: 0.00001,
          costSource: "price_table",
          responseMs: 20,
          status: "ok",
          outcome: "completed",
        },
      ],
    });
    const analyzed = (await agent.post(route).expect(201)).body;
    expect(analyzed).toMatchObject({
      status: "ready",
      sampleSize: 1,
      result: { themes: [{ label: "Pricing", mentions: 1 }] },
    });
    expect(JSON.stringify(analyzed)).not.toContain("test-key-never-used");
    expect(analysisRun).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: expect.objectContaining({ provider: "google" }),
        comments: ["Please explain the pricing for smaller teams."],
      }),
    );
    const ledger = await db
      .select()
      .from(schema.usageLedger)
      .where(
        and(eq(schema.usageLedger.orgId, orgId), eq(schema.usageLedger.step, "comment_analysis")),
      );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ keyOwnership: "byok", inputTokens: 20 });
    expect((await agent.post(route).expect(201)).body.status).toBe("ready");
    expect(analysisRun).toHaveBeenCalledTimes(1);
    await db
      .update(schema.newsItems)
      .set({ commentsCheckedAt: new Date("2026-09-23T11:00:00Z") })
      .where(eq(schema.newsItems.id, item.id));
    expect((await agent.get(route).expect(200)).body).toEqual({ status: "stale" });
  });
});
