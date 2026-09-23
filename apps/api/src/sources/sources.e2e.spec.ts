import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schema } from "@pubrick/db";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("watched sources e2e", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
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

  it("filters and orders scores without replacing the editor signal or crossing brands", async () => {
    const { agent: owner } = await orgAgent();
    const { agent: other } = await orgAgent();
    const brand = await owner.post("/api/brands").send({ name: "Cafe" }).expect(201);
    const source = await owner
      .post("/api/sources")
      .send({ brandId: brand.body.id, name: "Journal", url: "https://example.com/relevance.xml" })
      .expect(201);
    const { schema } = await import("@pubrick/db");
    const { db } = await import("../db");
    const { eq } = await import("drizzle-orm");
    const orgRows = await db
      .select({ orgId: schema.brands.orgId })
      .from(schema.brands)
      .where(eq(schema.brands.id, brand.body.id));
    const orgId = orgRows[0]?.orgId as string;
    const [high, low, pending] = await db
      .insert(schema.newsItems)
      .values([
        {
          orgId,
          brandId: brand.body.id,
          sourceId: source.body.id,
          title: "High",
          url: "https://example.com/high",
          relevanceStatus: "scored",
          relevanceScore: 0.9,
          relevanceReason: "Highly relevant",
          relevanceUrgency: "timely",
          relevanceScoredAt: new Date(),
          editorSignal: "irrelevant",
        },
        {
          orgId,
          brandId: brand.body.id,
          sourceId: source.body.id,
          title: "Low",
          url: "https://example.com/low",
          relevanceStatus: "scored",
          relevanceScore: 0.2,
          relevanceReason: "Weak fit",
          relevanceUrgency: "evergreen",
          relevanceScoredAt: new Date(),
        },
        {
          orgId,
          brandId: brand.body.id,
          sourceId: source.body.id,
          title: "Pending",
          url: "https://example.com/pending",
        },
      ])
      .returning({ id: schema.newsItems.id });
    if (!high || !low || !pending) throw new Error("Article seed failed");
    const ranked = await owner
      .get(`/api/sources/items?brandId=${brand.body.id}&sort=relevance&status=scored`)
      .expect(200);
    expect(ranked.body.map((row: { id: string }) => row.id)).toEqual([high.id, low.id]);
    expect(ranked.body[0]).toMatchObject({ relevanceScore: 0.9, editorSignal: "irrelevant" });
    const unscored = await owner
      .get(`/api/sources/items?brandId=${brand.body.id}&status=unscored`)
      .expect(200);
    expect(unscored.body.map((row: { id: string }) => row.id)).toEqual([pending.id]);
    await other.get(`/api/sources/items?brandId=${brand.body.id}&sort=relevance`).expect(404);
    await other.post(`/api/sources/items/${pending.id}/score?brandId=${brand.body.id}`).expect(404);
    await owner.post(`/api/sources/items/${high.id}/score?brandId=${brand.body.id}`).expect(409);
    await owner.post(`/api/sources/items/${pending.id}/score?brandId=${brand.body.id}`).expect(201);
  });
});
