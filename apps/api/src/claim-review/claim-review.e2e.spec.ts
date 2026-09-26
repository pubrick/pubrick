import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import { claimReviewDtoSchema } from "@pubrick/shared";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("claim review e2e", () => {
  let app: INestApplication;
  let direct: ReturnType<typeof createDb>;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
    direct = createDb(url as string);
  });

  afterAll(async () => {
    await app?.close();
    await direct?.pool.end();
  });

  async function orgAgent(label: string) {
    const agent = request.agent(app.getHttpServer());
    const suffix = randomUUID();
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `${label}-${suffix}@example.com`, password: "password1234", name: label })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: label, slug: `${label}-${suffix}`.toLowerCase() })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return { agent, orgId: org.body.id as string };
  }

  async function draft(agent: request.Agent, body: string) {
    const brand = await agent.post("/api/brands").send({ name: "Review brand" }).expect(201);
    const channel = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Review channel",
        credentials: { botToken: "123:abc", chatId: "-1001234567890" },
      })
      .expect(201);
    const created = await agent
      .post("/api/content")
      .send({ brandId: brand.body.id, title: "Review me", body, channelIds: [channel.body.id] })
      .expect(201);
    return created.body.id as string;
  }

  it("checks scope, exact body and keys, deduplicates active work, and leaves publication untouched", async () => {
    const owner = await orgAgent("ClaimReviewOwner");
    const stranger = await orgAgent("ClaimReviewStranger");
    const initial = "The city opened seven new libraries in 2025.";
    const itemId = await draft(owner.agent, initial);
    const path = `/api/content/${itemId}/claim-review`;

    expect((await owner.agent.get(path).expect(200)).body).toBeNull();
    await stranger.agent.get(path).expect(404);
    await stranger.agent.post(path).send({ expectedBody: initial }).expect(404);
    await owner.agent.post(path).send({ expectedBody: "A different body" }).expect(409);
    expect(
      (await owner.agent.post(path).send({ expectedBody: initial }).expect(409)).body.code,
    ).toBe("claim_review_no_search_key");

    await owner.agent
      .put("/api/search-credentials")
      .send({ apiKey: "search-key-for-test", folderId: "folder-1" })
      .expect(200);
    expect(
      (await owner.agent.post(path).send({ expectedBody: initial }).expect(409)).body.code,
    ).toBe("claim_review_no_ai_key");
    await owner.agent
      .put("/api/ai-credentials")
      .send({ provider: "google", apiKey: "gemini-key-for-test" })
      .expect(200);

    const first = claimReviewDtoSchema.parse(
      (await owner.agent.post(path).send({ expectedBody: initial }).expect(202)).body,
    );
    expect(first).toMatchObject({
      contentItemId: itemId,
      status: "queued",
      trigger: "manual",
      stale: false,
      claims: [],
      errorCode: null,
    });
    const duplicate = claimReviewDtoSchema.parse(
      (await owner.agent.post(path).send({ expectedBody: initial }).expect(202)).body,
    );
    expect(duplicate.id).toBe(first.id);
    expect(claimReviewDtoSchema.parse((await owner.agent.get(path).expect(200)).body)).toEqual(
      first,
    );
    const rows = await direct.db
      .select({ id: schema.claimReviews.id })
      .from(schema.claimReviews)
      .where(
        and(
          eq(schema.claimReviews.orgId, owner.orgId),
          eq(schema.claimReviews.contentItemId, itemId),
        ),
      );
    expect(rows).toHaveLength(1);
    const queued = await direct.pool.query<{
      name: string;
      retry_limit: number;
      dead_letter: string | null;
      data: { orgId: string; reviewId: string };
    }>("SELECT name, retry_limit, dead_letter, data FROM pgboss.job WHERE id = $1", [first.id]);
    expect(queued.rows).toEqual([
      {
        name: "claim-review",
        retry_limit: 0,
        dead_letter: "claim-review-dlq",
        data: { orgId: owner.orgId, reviewId: first.id },
      },
    ]);

    await owner.agent
      .patch(`/api/content/${itemId}`)
      .send({ body: `${initial} Another fact.` })
      .expect(200);
    expect((await owner.agent.get(path).expect(200)).body.stale).toBe(true);
    const [item] = await direct.db
      .select({ status: schema.contentItems.status })
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, itemId));
    expect(item?.status).toBe("draft");
    const adaptations = await direct.db
      .select({ status: schema.adaptations.status })
      .from(schema.adaptations)
      .where(eq(schema.adaptations.contentItemId, itemId));
    expect(adaptations.map((row) => row.status)).toEqual(["pending"]);

    await direct.db
      .update(schema.contentItems)
      .set({ status: "rejected" })
      .where(eq(schema.contentItems.id, itemId));
    const revised = `${initial} Another fact.`;
    expect(
      (await owner.agent.post(path).send({ expectedBody: revised }).expect(202)).body.id,
    ).not.toBe(first.id);
    await direct.db
      .update(schema.contentItems)
      .set({ status: "approved" })
      .where(eq(schema.contentItems.id, itemId));
    expect(
      (await owner.agent.post(path).send({ expectedBody: revised }).expect(409)).body.code,
    ).toBe("claim_review_not_editable");
  });
});
