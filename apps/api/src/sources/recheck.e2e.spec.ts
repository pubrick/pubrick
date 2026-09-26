import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schema } from "@pubrick/db";
import { encryptJson } from "@pubrick/shared";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("paid relevance recheck admission", () => {
  let app: INestApplication;
  let db: typeof import("../db").db;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    ({ db } = await import("../db"));
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

  async function owner() {
    const agent = request.agent(app.getHttpServer());
    const unique = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `recheck-${unique}@example.com`, password: "password1234", name: "Owner" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Recheck ${unique}`, slug: `recheck-${unique}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    const brand = await agent.post("/api/brands").send({ name: "Cafe" }).expect(201);
    const source = await agent
      .post("/api/sources")
      .send({ brandId: brand.body.id, name: "Journal", url: `https://example.com/${unique}.xml` })
      .expect(201);
    return {
      agent,
      orgId: org.body.id as string,
      brandId: brand.body.id as string,
      sourceId: source.body.id as string,
    };
  }

  it("validates bounds, snapshots scored stories and rejects a concurrent paid admission", async () => {
    const first = await owner();
    const other = await owner();
    const route = `/api/sources/items/recheck?brandId=${first.brandId}`;
    await db.insert(schema.newsItems).values([
      {
        orgId: first.orgId,
        brandId: first.brandId,
        sourceId: first.sourceId,
        title: "Already scored",
        url: "https://example.com/a",
        relevanceStatus: "scored",
        relevanceScore: 0.7,
        relevanceReason: "Old verdict",
        relevanceUrgency: "timely",
        relevanceScoredAt: new Date(),
      },
      {
        orgId: first.orgId,
        brandId: first.brandId,
        sourceId: first.sourceId,
        title: "Second",
        url: "https://example.com/b",
        relevanceStatus: "scored",
        relevanceScore: 0.4,
        relevanceReason: "Older verdict",
        relevanceUrgency: "evergreen",
        relevanceScoredAt: new Date(),
      },
      {
        orgId: first.orgId,
        brandId: first.brandId,
        sourceId: first.sourceId,
        title: "Dismissed scored",
        url: "https://example.com/dismissed-scored",
        relevanceStatus: "scored",
        relevanceScore: 0.95,
        relevanceReason: "Old verdict",
        relevanceUrgency: "timely",
        relevanceScoredAt: new Date(),
        dismissedAt: new Date(),
      },
      {
        orgId: first.orgId,
        brandId: first.brandId,
        sourceId: first.sourceId,
        title: "Unscored",
        url: "https://example.com/unscored",
      },
      {
        orgId: first.orgId,
        brandId: first.brandId,
        sourceId: first.sourceId,
        title: "Old",
        url: "https://example.com/old",
        createdAt: new Date("2025-01-01"),
      },
    ]);
    await first.agent.get(`${route.replace("/recheck?", "/recheck/preview?")}&days=0`).expect(400);
    await first.agent.get(`${route.replace("/recheck?", "/recheck/preview?")}&days=31`).expect(400);
    await first.agent.post(route).send({ days: 0, maxItems: 2 }).expect(400);
    await first.agent.post(route).send({ days: 7, maxItems: 501 }).expect(400);
    await other.agent.get(`${route.replace("/recheck?", "/recheck/preview?")}&days=7`).expect(404);
    await other.agent.get(route).expect(404);
    await other.agent.post(route).send({ days: 7, maxItems: 2 }).expect(404);

    const preview = await first.agent
      .get(`${route.replace("/recheck?", "/recheck/preview?")}&days=7`)
      .expect(200);
    expect(preview.body).toMatchObject({
      eligible: 2,
      capped: false,
      maxModelCalls: 2,
      maxEmbeddingCalls: 2,
      model: null,
      estimatedCostUsd: null,
    });
    await db.insert(schema.aiCredentials).values({
      orgId: first.orgId,
      provider: "google",
      credentialsEncrypted: encryptJson(
        { apiKey: "test-secret-that-must-not-leak" },
        process.env.APP_ENCRYPTION_KEY as string,
      ),
    });
    const priced = await first.agent
      .get(`${route.replace("/recheck?", "/recheck/preview?")}&days=7`)
      .expect(200);
    expect(priced.body).toMatchObject({ eligible: 2, model: "gemini-3.8-flash" });
    expect(priced.body.estimatedCostUsd).toBeGreaterThan(0);
    expect(JSON.stringify(priced.body)).not.toContain("test-secret");
    await first.agent.post(route).send({ days: 7, maxItems: 1 }).expect(409);
    // QueueService imports env.ts; load it only after beforeAll installs DATABASE_URL.
    const { QueueService } = await import("../queue/queue.service");
    const enqueue = vi
      .spyOn(app.get(QueueService), "enqueueRelevanceBatch")
      .mockRejectedValueOnce(new Error("queue unavailable"));
    await first.agent.post(route).send({ days: 7, maxItems: 2 }).expect(500);
    enqueue.mockRestore();
    expect((await first.agent.get(route).expect(200)).body).toEqual({ batch: null });
    expect(
      await db
        .select({ id: schema.relevanceBatches.id })
        .from(schema.relevanceBatches)
        .where(eq(schema.relevanceBatches.orgId, first.orgId)),
    ).toHaveLength(0);
    const [a, b] = await Promise.all([
      first.agent.post(route).send({ days: 7, maxItems: 2 }),
      first.agent.post(route).send({ days: 7, maxItems: 2 }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const admitted = a.status === 201 ? a : b;
    const denied = a.status === 409 ? a : b;
    expect(denied.body.code).toBe("recheck_busy");
    expect(admitted.body).toMatchObject({ selectedCount: 2, processedCount: 0, status: "queued" });
    const items = await db
      .select({ itemId: schema.relevanceBatchItems.itemId })
      .from(schema.relevanceBatchItems)
      .where(
        and(
          eq(schema.relevanceBatchItems.orgId, first.orgId),
          eq(schema.relevanceBatchItems.batchId, admitted.body.id),
        ),
      );
    expect(items).toHaveLength(2);
    const dismissed = await db
      .select({ id: schema.newsItems.id })
      .from(schema.newsItems)
      .where(
        and(
          eq(schema.newsItems.orgId, first.orgId),
          eq(schema.newsItems.title, "Dismissed scored"),
        ),
      );
    expect(items.map((item) => item.itemId)).not.toContain(dismissed[0]?.id);
    expect((await first.agent.get(route).expect(200)).body.batch.id).toBe(admitted.body.id);
    // Admission never mutates old verdicts before an explicitly queued worker runs.
    const [old] = await db
      .select({ reason: schema.newsItems.relevanceReason })
      .from(schema.newsItems)
      .where(
        and(eq(schema.newsItems.orgId, first.orgId), eq(schema.newsItems.title, "Already scored")),
      );
    expect(old?.reason).toBe("Old verdict");
  });

  it("caps the preview at 500 even when the archive is larger", async () => {
    const fixture = await owner();
    await db.insert(schema.newsItems).values(
      Array.from({ length: 501 }, (_, index) => ({
        orgId: fixture.orgId,
        brandId: fixture.brandId,
        sourceId: fixture.sourceId,
        title: `Scored ${index}`,
        url: `https://example.com/bulk-${index}`,
        relevanceStatus: "scored" as const,
        relevanceScore: 0.5,
        relevanceReason: "Prior verdict",
        relevanceUrgency: "timely" as const,
        relevanceScoredAt: new Date(),
        ...(index === 0 ? { dismissedAt: new Date() } : {}),
      })),
    );
    const before = await fixture.agent
      .get(`/api/sources/items/recheck/preview?brandId=${fixture.brandId}&days=30`)
      .expect(200);
    expect(before.body).toMatchObject({ eligible: 500, capped: false });
    await db.insert(schema.newsItems).values({
      orgId: fixture.orgId,
      brandId: fixture.brandId,
      sourceId: fixture.sourceId,
      title: "One more visible",
      url: "https://example.com/one-more-visible",
      relevanceStatus: "scored",
      relevanceScore: 0.5,
      relevanceReason: "Prior verdict",
      relevanceUrgency: "timely",
      relevanceScoredAt: new Date(),
    });
    const preview = await fixture.agent
      .get(`/api/sources/items/recheck/preview?brandId=${fixture.brandId}&days=30`)
      .expect(200);
    expect(preview.body).toMatchObject({
      eligible: 500,
      capped: true,
      maxModelCalls: 500,
      maxEmbeddingCalls: 500,
    });
  });
});
