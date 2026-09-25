import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { UsageRecord } from "@pubrick/ai";
import { schema } from "@pubrick/db";
import {
  analyticsDtoSchema,
  brandOverviewDtoSchema,
  commentAnalysisDtoSchema,
  publicationCommentsDtoSchema,
  publicationMetricsDtoSchema,
} from "@pubrick/shared";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CommentAnalysisCaller } from "../sources/comment-analysis.caller";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("publication analytics e2e", () => {
  let app: INestApplication;
  let db: typeof import("../db")["db"];
  let vkServer: Server;
  let calls = 0;
  const analysisRun = vi.fn();

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

  it("counts brand activity by event window without multiplying linked costs or leaking tenants", async () => {
    const owner = await orgAgent();
    const outsider = await orgAgent();
    const brand = await owner.agent.post("/api/brands").send({ name: "Overview" }).expect(201);
    const sibling = await owner.agent.post("/api/brands").send({ name: "Sibling" }).expect(201);
    const now = Date.now();
    const daysAgo = (days: number) => new Date(now - days * 86_400_000);
    const [item, oldItem, siblingItem] = await db
      .insert(schema.contentItems)
      .values([
        {
          orgId: owner.orgId,
          brandId: brand.body.id,
          body: "Current",
          origin: "ai",
          status: "approved",
          createdAt: daysAgo(2),
        },
        {
          orgId: owner.orgId,
          brandId: brand.body.id,
          body: "Old",
          status: "draft",
          createdAt: daysAgo(40),
        },
        { orgId: owner.orgId, brandId: sibling.body.id, body: "Sibling", createdAt: daysAgo(2) },
      ])
      .returning({ id: schema.contentItems.id });
    if (!item || !oldItem || !siblingItem) throw new Error("Missing overview item");
    const [run, legacyRun, siblingRun] = await db
      .insert(schema.pipelineRuns)
      .values([
        {
          orgId: owner.orgId,
          brandId: brand.body.id,
          contentItemId: item.id,
          input: { kind: "brief", text: "Current", channelIds: [] },
          status: "succeeded",
          unrecordedCalls: 2,
          createdAt: daysAgo(2),
        },
        {
          orgId: owner.orgId,
          brandId: brand.body.id,
          input: { kind: "brief", text: "Legacy", channelIds: [] },
          status: "failed",
          unrecordedCalls: null,
          createdAt: daysAgo(12),
        },
        {
          orgId: owner.orgId,
          brandId: sibling.body.id,
          contentItemId: siblingItem.id,
          input: { kind: "brief", text: "Sibling", channelIds: [] },
          status: "succeeded",
          createdAt: daysAgo(2),
        },
      ])
      .returning({ id: schema.pipelineRuns.id });
    if (!run || !legacyRun || !siblingRun) throw new Error("Missing overview run");
    await db.insert(schema.promptDecisions).values([
      {
        orgId: owner.orgId,
        contentItemId: item.id,
        verdict: "approved",
        ordinal: 1,
        createdAt: daysAgo(1),
      },
      {
        orgId: owner.orgId,
        contentItemId: item.id,
        verdict: "rejected",
        ordinal: 2,
        createdAt: daysAgo(1),
      },
      {
        orgId: owner.orgId,
        contentItemId: oldItem.id,
        verdict: "approved",
        ordinal: 1,
        createdAt: daysAgo(40),
      },
      {
        orgId: owner.orgId,
        contentItemId: siblingItem.id,
        verdict: "approved",
        ordinal: 1,
        createdAt: daysAgo(1),
      },
    ]);
    const [channel] = await db
      .insert(schema.channels)
      .values({ orgId: owner.orgId, brandId: brand.body.id, platform: "vc_ru", name: "VC" })
      .returning({ id: schema.channels.id });
    if (!channel) throw new Error("Missing overview channel");
    const [adaptation] = await db
      .insert(schema.adaptations)
      .values({
        orgId: owner.orgId,
        contentItemId: item.id,
        channelId: channel.id,
        status: "published",
      })
      .returning({ id: schema.adaptations.id });
    if (!adaptation) throw new Error("Missing overview adaptation");
    await db.insert(schema.publications).values({
      orgId: owner.orgId,
      adaptationId: adaptation.id,
      channelId: channel.id,
      status: "published",
      createdAt: daysAgo(1),
    });
    // A receipt may have been created in_flight long before it became
    // published. Its creation time, not its later status change, owns the window.
    const [oldAdaptation] = await db
      .insert(schema.adaptations)
      .values({
        orgId: owner.orgId,
        contentItemId: oldItem.id,
        channelId: channel.id,
        status: "published",
      })
      .returning({ id: schema.adaptations.id });
    if (!oldAdaptation) throw new Error("Missing older adaptation");
    await db.insert(schema.publications).values({
      orgId: owner.orgId,
      adaptationId: oldAdaptation.id,
      channelId: channel.id,
      status: "published",
      createdAt: daysAgo(40),
    });
    await db.insert(schema.usageLedger).values([
      {
        orgId: owner.orgId,
        runId: run.id,
        contentItemId: item.id,
        channelId: channel.id,
        step: "writer",
        provider: "google",
        modelId: "test",
        costUsd: "0.125000",
        costSource: "price_table",
        status: "ok",
        outcome: "completed",
        createdAt: daysAgo(1),
      },
      {
        orgId: owner.orgId,
        runId: run.id,
        step: "editor",
        provider: "google",
        modelId: "test",
        inputTokens: 50,
        costSource: "unknown",
        status: "errored",
        outcome: "unknown",
        createdAt: daysAgo(1),
      },
      {
        orgId: owner.orgId,
        runId: siblingRun.id,
        step: "writer",
        provider: "google",
        modelId: "test",
        costUsd: "5.000000",
        costSource: "provider_reported",
        status: "ok",
        outcome: "completed",
        createdAt: daysAgo(1),
      },
    ]);
    await db.insert(schema.claimReviews).values([
      {
        orgId: owner.orgId,
        contentItemId: item.id,
        bodyHash: "a".repeat(64),
        status: "ready",
        completedAt: daysAgo(1),
        createdAt: daysAgo(1),
        unrecordedCalls: 3,
      },
      {
        orgId: owner.orgId,
        contentItemId: siblingItem.id,
        bodyHash: "b".repeat(64),
        status: "ready",
        completedAt: daysAgo(1),
        createdAt: daysAgo(1),
        unrecordedCalls: 4,
      },
      {
        orgId: owner.orgId,
        contentItemId: oldItem.id,
        bodyHash: "c".repeat(64),
        status: "ready",
        completedAt: daysAgo(40),
        createdAt: daysAgo(40),
        unrecordedCalls: 5,
      },
    ]);
    const path = `/api/analytics/brands/${brand.body.id}/overview`;
    await outsider.agent.get(`${path}?days=30`).expect(404);
    await owner.agent.get(`${path}?days=365`).expect(400);
    const week = brandOverviewDtoSchema.parse(
      (await owner.agent.get(`${path}?days=7`).expect(200)).body,
    );
    expect(week.drafts).toMatchObject({ total: 1, ai: 1, approved: 1 });
    expect(week.runs).toMatchObject({ total: 1, succeeded: 1 });
    expect(week.decisions).toEqual({ approved: 1, rejected: 1 });
    expect(week.publications).toMatchObject({
      total: 1,
      byPlatform: [{ platform: "vc_ru", count: 1 }],
    });
    expect(week.spend).toEqual({
      knownUsd: 0.125,
      pricedCalls: 1,
      estimatedCalls: 1,
      unpricedCalls: 1,
      unrecordedCalls: 2,
      reviewUnrecordedCalls: 3,
      legacyRuns: 0,
    });
    const month = brandOverviewDtoSchema.parse(
      (await owner.agent.get(`${path}?days=30`).expect(200)).body,
    );
    expect(month.runs).toMatchObject({ total: 2, failed: 1 });
    expect(month.spend.legacyRuns).toBe(1);
    const quarter = brandOverviewDtoSchema.parse(
      (await owner.agent.get(`${path}?days=90`).expect(200)).body,
    );
    expect(quarter.drafts.total).toBe(2);
    expect(quarter.decisions.approved).toBe(2);
    expect(quarter.publications.total).toBe(2);
    expect(quarter.spend.reviewUnrecordedCalls).toBe(8);
    expect(
      (
        await owner.agent
          .get(`/api/analytics/brands/${sibling.body.id}/overview?days=30`)
          .expect(200)
      ).body.spend.knownUsd,
    ).toBe(5);
  });

  it("keeps publication auto-collection off until an authorized brand opts in and increments the fence on every change", async () => {
    const owner = await orgAgent();
    const stranger = await orgAgent();
    const brand = await owner.agent.post("/api/brands").send({ name: "Reply consent" }).expect(201);
    const path = `/api/analytics/brands/${brand.body.id}/comment-collection`;
    expect((await owner.agent.get(path).expect(200)).body).toEqual({
      enabled: false,
      updatedAt: null,
    });
    await stranger.agent.get(path).expect(404);
    await stranger.agent.put(path).send({ enabled: true }).expect(404);
    await owner.agent.put(path).send({ enabled: "yes" }).expect(400);
    const enabled = await owner.agent.put(path).send({ enabled: true }).expect(200);
    expect(enabled.body).toMatchObject({ enabled: true });
    const disabled = await owner.agent.put(path).send({ enabled: false }).expect(200);
    expect(disabled.body).toMatchObject({ enabled: false });
    await owner.agent.put(path).send({ enabled: true }).expect(200);
    const [row] = await db
      .select({ revision: schema.publicationCommentCollectionConfigs.revision })
      .from(schema.publicationCommentCollectionConfigs)
      .where(eq(schema.publicationCommentCollectionConfigs.brandId, brand.body.id));
    expect(row?.revision).toBe(3);
  });

  it("collects only an owned public Telegram publication and recovers an abandoned request", async () => {
    const owner = await orgAgent();
    const other = await orgAgent();
    const brand = await owner.agent.post("/api/brands").send({ name: "Discussion" }).expect(201);
    const unrelatedBrand = await owner.agent
      .post("/api/brands")
      .send({ name: "Unrelated" })
      .expect(201);
    const channel = await owner.agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Public Telegram",
        credentials: { botToken: "123:abc", chatId: "@pubrick" },
      })
      .expect(201);
    const [item] = await db
      .insert(schema.contentItems)
      .values({
        orgId: owner.orgId,
        brandId: brand.body.id,
        title: "Discussion post",
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
        channelId: channel.body.id,
        status: "published",
      })
      .returning({ id: schema.adaptations.id });
    if (!adaptation) throw new Error("No adaptation");
    const [publication] = await db
      .insert(schema.publications)
      .values({
        orgId: owner.orgId,
        adaptationId: adaptation.id,
        channelId: channel.body.id,
        status: "published",
        externalId: "42",
        externalUrl: "https://t.me/pubrick_public/42",
      })
      .returning({ id: schema.publications.id });
    if (!publication) throw new Error("No publication");
    const path = `/api/analytics/brands/${brand.body.id}/publications/${publication.id}/comments`;
    expect(
      publicationCommentsDtoSchema.parse((await owner.agent.get(path).expect(200)).body),
    ).toMatchObject({ status: "not_collected", requestedAt: null, canCollect: true, comments: [] });
    await other.agent.get(path).expect(404);
    await other.agent.post(`${path}/refresh`).expect(404);
    const unrelatedPath = `/api/analytics/brands/${unrelatedBrand.body.id}/publications/${publication.id}/comments`;
    await owner.agent.get(unrelatedPath).expect(404);
    await owner.agent.post(`${unrelatedPath}/refresh`).expect(404);
    expect((await owner.agent.post(`${path}/refresh`).expect(200)).body).toEqual({ queued: true });
    const pending = publicationCommentsDtoSchema.parse(
      (await owner.agent.get(path).expect(200)).body,
    );
    expect(pending).toMatchObject({ status: "pending", canCollect: true, comments: [] });
    expect(pending.requestedAt).toBeTruthy();
    expect((await owner.agent.post(`${path}/refresh`).expect(409)).body.code).toBe(
      "publication_comments_refresh_cooldown",
    );
    await db
      .update(schema.publicationCommentSamples)
      .set({ requestedAt: new Date(Date.now() - 16 * 60 * 1000) })
      .where(eq(schema.publicationCommentSamples.publicationId, publication.id));
    const abandoned = publicationCommentsDtoSchema.parse(
      (await owner.agent.get(path).expect(200)).body,
    );
    expect(abandoned).toMatchObject({
      status: "error",
      errorCode: "telegram_collection_failed",
      canCollect: true,
    });
    const [privateAdaptation] = await db
      .insert(schema.adaptations)
      .values({
        orgId: owner.orgId,
        contentItemId: item.id,
        channelId: channel.body.id,
        status: "published",
      })
      .returning({ id: schema.adaptations.id });
    if (!privateAdaptation) throw new Error("No private adaptation");
    const [privatePublication] = await db
      .insert(schema.publications)
      .values({
        orgId: owner.orgId,
        adaptationId: privateAdaptation.id,
        channelId: channel.body.id,
        status: "published",
        externalId: "43",
        externalUrl: "https://t.me/c/123456/43",
      })
      .returning({ id: schema.publications.id });
    if (!privatePublication) throw new Error("No private publication");
    const privatePath = `/api/analytics/brands/${brand.body.id}/publications/${privatePublication.id}/comments`;
    expect(
      publicationCommentsDtoSchema.parse((await owner.agent.get(privatePath).expect(200)).body),
    ).toMatchObject({ status: "unavailable", canCollect: false, comments: [] });
    expect((await owner.agent.post(`${privatePath}/refresh`).expect(409)).body.code).toBe(
      "publication_comments_unavailable",
    );
    await db.delete(schema.adaptations).where(eq(schema.adaptations.id, adaptation.id));
    await owner.agent.get(path).expect(404);
  });

  it("analyzes only an owned saved reply sample and fences a recollection in flight", async () => {
    const owner = await orgAgent();
    const other = await orgAgent();
    const brand = await owner.agent
      .post("/api/brands")
      .send({ name: "Reader feedback" })
      .expect(201);
    const unrelatedBrand = await owner.agent
      .post("/api/brands")
      .send({ name: "Other brand" })
      .expect(201);
    const channel = await owner.agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Public channel",
        credentials: { botToken: "123:abc", chatId: "@pubrick" },
      })
      .expect(201);
    const [item] = await db
      .insert(schema.contentItems)
      .values({
        orgId: owner.orgId,
        brandId: brand.body.id,
        title: "Pricing update",
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
        channelId: channel.body.id,
        status: "published",
      })
      .returning({ id: schema.adaptations.id });
    if (!adaptation) throw new Error("No adaptation");
    const [publication] = await db
      .insert(schema.publications)
      .values({
        orgId: owner.orgId,
        adaptationId: adaptation.id,
        channelId: channel.body.id,
        status: "published",
        externalId: "84",
        externalUrl: "https://t.me/pubrick_public/84",
      })
      .returning({ id: schema.publications.id });
    if (!publication) throw new Error("No publication");
    const path = `/api/analytics/brands/${brand.body.id}/publications/${publication.id}/comment-analysis`;
    const checkedAt = new Date("2026-09-24T10:00:00Z");
    await db.insert(schema.publicationCommentSamples).values({
      orgId: owner.orgId,
      brandId: brand.body.id,
      publicationId: publication.id,
      status: "available",
      checkedAt,
    });
    await db.insert(schema.publicationComments).values({
      orgId: owner.orgId,
      brandId: brand.body.id,
      publicationId: publication.id,
      telegramMessageId: 85,
      body: "How does the small team price work?",
      publishedAt: new Date("2026-09-24T10:01:00Z"),
    });
    await owner.agent
      .get(path)
      .expect(200)
      .then(({ body }) => {
        expect(body).toEqual({ status: "no_key" });
      });
    await other.agent.get(path).expect(404);
    await other.agent.post(path).expect(404);
    const wrongBrandPath = `/api/analytics/brands/${unrelatedBrand.body.id}/publications/${publication.id}/comment-analysis`;
    await owner.agent.get(wrongBrandPath).expect(404);
    await owner.agent.post(wrongBrandPath).expect(404);
    await owner.agent
      .put("/api/ai-credentials")
      .send({ provider: "google", apiKey: "publication-test-key-never-used" })
      .expect(200);
    expect((await owner.agent.get(path).expect(200)).body).toEqual({ status: "not_analyzed" });
    const result = {
      summary: "Readers need a clearer price explanation.",
      sentiment: { positive: 0, neutral: 1, negative: 0 },
      themes: [{ label: "Pricing", mentions: 1 }],
      feedback: ["Explain the small team plan."],
    };
    const usage: UsageRecord = {
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
    };
    analysisRun.mockImplementationOnce(
      async (args: { onUsage: (record: UsageRecord) => Promise<void> }) => {
        await args.onUsage(usage);
        return { ok: true, result, usage: [] };
      },
    );
    const ready = commentAnalysisDtoSchema.parse((await owner.agent.post(path).expect(200)).body);
    expect(ready).toMatchObject({ status: "ready", sampleSize: 1, result });
    expect(JSON.stringify(ready)).not.toContain("publication-test-key-never-used");
    expect(analysisRun).toHaveBeenCalledWith(
      expect.objectContaining({
        comments: ["How does the small team price work?"],
        title: "Pricing update",
        credential: expect.objectContaining({ provider: "google" }),
      }),
    );
    const ledger = await db
      .select({ step: schema.usageLedger.step, keyOwnership: schema.usageLedger.keyOwnership })
      .from(schema.usageLedger)
      .where(
        and(
          eq(schema.usageLedger.orgId, owner.orgId),
          eq(schema.usageLedger.step, "publication_comment_analysis"),
        ),
      );
    expect(ledger).toEqual([{ step: "publication_comment_analysis", keyOwnership: "byok" }]);
    expect((await owner.agent.post(path).expect(200)).body.status).toBe("ready");
    expect(analysisRun).toHaveBeenCalledTimes(1);

    await db
      .update(schema.publicationCommentSamples)
      .set({ checkedAt: new Date("2026-09-24T11:00:00Z") })
      .where(eq(schema.publicationCommentSamples.publicationId, publication.id));
    expect((await owner.agent.get(path).expect(200)).body).toEqual({ status: "stale" });
    let releaseCall: () => void = () => {};
    let callStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      callStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseCall = resolve;
    });
    analysisRun.mockImplementationOnce(
      async (args: { onUsage: (record: UsageRecord) => Promise<void> }) => {
        callStarted();
        await release;
        await args.onUsage(usage);
        return { ok: true, result, usage: [] };
      },
    );
    const first = owner.agent.post(path).then(({ body, status }) => ({ body, status }));
    await started;
    expect((await owner.agent.post(path).expect(200)).body).toEqual({ status: "in_progress" });
    await db
      .update(schema.publicationCommentSamples)
      .set({ requestedAt: new Date("2026-09-24T11:05:00Z") })
      .where(eq(schema.publicationCommentSamples.publicationId, publication.id));
    releaseCall();
    expect(await first).toMatchObject({ status: 200, body: { status: "stale" } });
    expect((await owner.agent.get(path).expect(200)).body).toEqual({ status: "stale" });
    expect(analysisRun).toHaveBeenCalledTimes(2);
  });

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
