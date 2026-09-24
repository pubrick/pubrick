import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schema } from "@pubrick/db";
import { analyticsDtoSchema, publicationMetricsDtoSchema } from "@pubrick/shared";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("publication analytics e2e", () => {
  let app: INestApplication;
  let db: typeof import("../db")["db"];
  let vkServer: Server;
  let calls = 0;

  beforeAll(async () => {
    vkServer = createServer(async (req, res) => {
      if (req.url !== "/method/wall.getById") {
        res.writeHead(404).end();
        return;
      }
      calls++;
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = new URLSearchParams(Buffer.concat(chunks).toString());
      const id = body.get("posts");
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          response: {
            items:
              id === "-123_9"
                ? [
                    {
                      owner_id: -123,
                      id: 9,
                      views: { count: 0 },
                      likes: { count: 3 },
                      comments: { count: 1 },
                      reposts: { count: 2 },
                    },
                  ]
                : [],
          },
        }),
      );
    });
    await new Promise<void>((resolve) => vkServer.listen(0, "127.0.0.1", resolve));
    const address = vkServer.address();
    if (!address || typeof address === "string") throw new Error("Missing VK test listener");
    process.env.VK_API_BASE_URL = `http://127.0.0.1:${address.port}/method`;
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
    await app?.close();
    await new Promise<void>((resolve) => vkServer?.close(() => resolve()));
  });

  async function orgAgent() {
    const agent = request.agent(app.getHttpServer());
    const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `analytics${uniq}@example.com`, password: "password1234", name: "U" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${uniq}`, slug: `analytics-org-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return { agent, orgId: org.body.id as string };
  }

  it("isolates brands and orgs, preserves unknown values, reads VK once and honors cooldown", async () => {
    const owner = await orgAgent();
    const other = await orgAgent();
    const brand = await owner.agent.post("/api/brands").send({ name: "Newsroom" }).expect(201);
    const vk = await owner.agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "vk",
        name: "VK News",
        credentials: { accessToken: "fake-test-token", groupId: "123" },
      })
      .expect(201);
    const [item] = await db
      .insert(schema.contentItems)
      .values({
        orgId: owner.orgId,
        brandId: brand.body.id,
        title: "A story",
        body: "Body",
        status: "published",
      })
      .returning({ id: schema.contentItems.id });
    if (!item) throw new Error("No item");
    const [adaptation] = await db
      .insert(schema.adaptations)
      .values({
        orgId: owner.orgId,
        contentItemId: item.id,
        channelId: vk.body.id,
        status: "published",
      })
      .returning({ id: schema.adaptations.id });
    if (!adaptation) throw new Error("No adaptation");
    const [publication] = await db
      .insert(schema.publications)
      .values({
        orgId: owner.orgId,
        adaptationId: adaptation.id,
        channelId: vk.body.id,
        status: "published",
        externalId: "9",
        externalUrl: "https://vk.com/wall-123_9",
      })
      .returning({ id: schema.publications.id });
    if (!publication) throw new Error("No publication");
    const path = `/api/analytics/brands/${brand.body.id}`;
    await other.agent.get(`${path}?days=30`).expect(404);
    await other.agent.post(`${path}/publications/${publication.id}/refresh`).expect(404);
    const first = analyticsDtoSchema.parse(
      (await owner.agent.get(`${path}?days=30`).expect(200)).body,
    );
    expect(first).toMatchObject({
      publishedCount: 1,
      measuredCount: 0,
      totals: { views: null, likes: null },
      posts: [{ metrics: { status: "not_collected", views: null, likes: null } }],
    });
    expect((await owner.agent.get(`${path}?days=365`).expect(400)).body).toBeTruthy();
    const refreshed = publicationMetricsDtoSchema.parse(
      (await owner.agent.post(`${path}/publications/${publication.id}/refresh`).expect(200)).body,
    );
    expect(refreshed).toMatchObject({
      status: "available",
      views: 0,
      likes: 3,
      comments: 1,
      shares: 2,
    });
    expect(calls).toBe(1);
    expect(
      (await owner.agent.post(`${path}/publications/${publication.id}/refresh`).expect(409)).body
        .code,
    ).toBe("metrics_refresh_cooldown");
    expect(calls).toBe(1);
    const second = analyticsDtoSchema.parse(
      (await owner.agent.get(`${path}?days=30`).expect(200)).body,
    );
    expect(second).toMatchObject({ measuredCount: 1, totals: { views: 0, likes: 3 } });
    expect(second.posts[0]?.canRefresh).toBe(false);
    await db
      .update(schema.publicationMetrics)
      .set({ checkedAt: new Date(Date.now() - 48 * 60 * 60 * 1000) })
      .where(
        and(
          eq(schema.publicationMetrics.orgId, owner.orgId),
          eq(schema.publicationMetrics.publicationId, publication.id),
        ),
      );
    expect((await owner.agent.get(`${path}?days=30`).expect(200)).body.posts[0].metrics.stale).toBe(
      true,
    );
    expect(
      (await owner.agent.post(`${path}/publications/${randomUUID()}/refresh`).expect(404)).body
        .code,
    ).toBe("publication_not_found");

    const telegram = await owner.agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Telegram",
        credentials: { botToken: "123:abc", chatId: "@pubrick" },
      })
      .expect(201);
    const [telegramAdaptation] = await db
      .insert(schema.adaptations)
      .values({
        orgId: owner.orgId,
        contentItemId: item.id,
        channelId: telegram.body.id,
        status: "published",
      })
      .returning({ id: schema.adaptations.id });
    if (!telegramAdaptation) throw new Error("No Telegram adaptation");
    const [telegramPublication] = await db
      .insert(schema.publications)
      .values({
        orgId: owner.orgId,
        adaptationId: telegramAdaptation.id,
        channelId: telegram.body.id,
        status: "published",
        externalId: "42",
      })
      .returning({ id: schema.publications.id });
    if (!telegramPublication) throw new Error("No Telegram publication");
    const telegramResult = analyticsDtoSchema.parse(
      (await owner.agent.get(`${path}?days=30`).expect(200)).body,
    );
    expect(telegramResult.posts.find((post) => post.id === telegramPublication.id)).toMatchObject({
      canRefresh: false,
      metrics: { status: "not_collected", views: null },
    });
    expect(
      (await owner.agent.post(`${path}/publications/${telegramPublication.id}/refresh`).expect(409))
        .body.code,
    ).toBe("metrics_unavailable");
  });

  it("keeps background checks opt-in and scoped to VK channels and their organization", async () => {
    const owner = await orgAgent();
    const other = await orgAgent();
    const brand = await owner.agent
      .post("/api/brands")
      .send({ name: "Metrics settings" })
      .expect(201);
    const vk = await owner.agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "vk",
        name: "VK",
        credentials: { accessToken: "fake-test-token", groupId: "123" },
      })
      .expect(201);
    expect(vk.body.metricsAutoRefresh).toBe(false);
    await other.agent
      .patch(`/api/channels/${vk.body.id}`)
      .send({ metricsAutoRefresh: true })
      .expect(404);
    const enabled = await owner.agent
      .patch(`/api/channels/${vk.body.id}`)
      .send({ metricsAutoRefresh: true })
      .expect(200);
    expect(enabled.body.metricsAutoRefresh).toBe(true);
    expect(
      (await owner.agent.get(`/api/channels?brandId=${brand.body.id}`).expect(200)).body[0]
        .metricsAutoRefresh,
    ).toBe(true);
    const telegram = await owner.agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Telegram",
        credentials: { botToken: "123:abc", chatId: "@pubrick" },
      })
      .expect(201);
    await owner.agent
      .patch(`/api/channels/${telegram.body.id}`)
      .send({ metricsAutoRefresh: true })
      .expect(400);
    const disabled = await owner.agent
      .patch(`/api/channels/${vk.body.id}`)
      .send({ metricsAutoRefresh: false })
      .expect(200);
    expect(disabled.body.metricsAutoRefresh).toBe(false);
  });
});
