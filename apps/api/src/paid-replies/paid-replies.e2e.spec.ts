import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import {
  brandPaidReplySettingsDtoSchema,
  organizationPaidReplySettingsDtoSchema,
} from "@pubrick/shared";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("paid reply settings API", () => {
  let app: INestApplication;
  let db: ReturnType<typeof createDb>["db"];
  let pool: ReturnType<typeof createDb>["pool"];

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    ({ db, pool } = createDb(url as string));
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  async function signUp(name: string) {
    const agent = request.agent(app.getHttpServer());
    const suffix = randomUUID();
    const signed = await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `${name}-${suffix}@example.com`, password: "password1234", name })
      .expect(200);
    return { agent, userId: signed.body.user.id as string };
  }

  async function createOrg(owner: Awaited<ReturnType<typeof signUp>>) {
    const suffix = randomUUID();
    const created = await owner.agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${suffix}`, slug: `paid-${suffix}` })
      .expect(200);
    await owner.agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: created.body.id })
      .expect(200);
    return created.body.id as string;
  }

  it("keeps source/publication consent separate, default off, and revision fenced", async () => {
    const owner = await signUp("Owner");
    const orgId = await createOrg(owner);
    const brandId = (await owner.agent.post("/api/brands").send({ name: "Paid" }).expect(201)).body
      .id as string;
    const orgPath = "/api/paid-replies/organization";
    const brandPath = `/api/paid-replies/brands/${brandId}`;

    expect(
      organizationPaidReplySettingsDtoSchema.parse(
        (await owner.agent.get(orgPath).expect(200)).body,
      ),
    ).toMatchObject({
      timezone: "UTC",
      dailyThresholdUsd: 5,
      revision: 0,
      admittedCostUsd: 0,
      blockedReason: null,
    });
    expect(
      brandPaidReplySettingsDtoSchema.parse((await owner.agent.get(brandPath).expect(200)).body),
    ).toMatchObject({
      sourceEnabled: false,
      publicationEnabled: false,
      dailyThresholdUsd: 1,
      sourceRevision: 0,
      publicationRevision: 0,
      thresholdRevision: 0,
    });

    const source = await owner.agent.put(`${brandPath}/source`).send({ enabled: true }).expect(200);
    expect(source.body).toMatchObject({
      sourceEnabled: true,
      publicationEnabled: false,
      sourceRevision: 1,
      publicationRevision: 0,
    });
    const publication = await owner.agent
      .put(`${brandPath}/publication`)
      .send({ enabled: true })
      .expect(200);
    expect(publication.body).toMatchObject({
      sourceEnabled: true,
      publicationEnabled: true,
      sourceRevision: 1,
      publicationRevision: 1,
    });
    const repeated = await owner.agent
      .put(`${brandPath}/source`)
      .send({ enabled: true })
      .expect(200);
    expect(repeated.body.sourceRevision).toBe(2);
    expect(repeated.body.publicationRevision).toBe(1);
    expect(
      await db
        .select({ id: schema.newsCommentCollectionConfigs.brandId })
        .from(schema.newsCommentCollectionConfigs)
        .where(eq(schema.newsCommentCollectionConfigs.brandId, brandId)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: schema.publicationCommentCollectionConfigs.brandId })
        .from(schema.publicationCommentCollectionConfigs)
        .where(eq(schema.publicationCommentCollectionConfigs.brandId, brandId)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: schema.paidReplyAnalysisAttempts.id })
        .from(schema.paidReplyAnalysisAttempts)
        .where(eq(schema.paidReplyAnalysisAttempts.orgId, orgId)),
    ).toEqual([]);

    await owner.agent
      .put(orgPath)
      .send({ timezone: "Mars/Olympus", dailyThresholdUsd: 5 })
      .expect(400);
    await owner.agent.put(orgPath).send({ timezone: "UTC", dailyThresholdUsd: 0 }).expect(400);
    await owner.agent.put(`${brandPath}/threshold`).send({ dailyThresholdUsd: 5.01 }).expect(400);
    const org = await owner.agent
      .put(orgPath)
      .send({ timezone: "Europe/Moscow", dailyThresholdUsd: 3 })
      .expect(200);
    expect(org.body).toMatchObject({
      timezone: "Europe/Moscow",
      dailyThresholdUsd: 3,
      revision: 1,
    });
    const threshold = await owner.agent
      .put(`${brandPath}/threshold`)
      .send({ dailyThresholdUsd: 2 })
      .expect(200);
    expect(threshold.body).toMatchObject({ dailyThresholdUsd: 2, thresholdRevision: 1 });
    await owner.agent.put(`${brandPath}/threshold`).send({ dailyThresholdUsd: 4 }).expect(400);
    await owner.agent.put(orgPath).send({ timezone: "UTC", dailyThresholdUsd: 1 }).expect(400);

    const viewer = await signUp("Viewer");
    const viewerMemberId = randomUUID();
    await db
      .insert(schema.member)
      .values({ id: viewerMemberId, organizationId: orgId, userId: viewer.userId, role: "member" });
    await db.insert(schema.brandAccess).values({ orgId, brandId, memberId: viewerMemberId });
    await viewer.agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    await viewer.agent.get(orgPath).expect(200);
    await viewer.agent.get(brandPath).expect(200);
    await viewer.agent.put(orgPath).send({ timezone: "UTC", dailyThresholdUsd: 3 }).expect(403);
    await viewer.agent.put(`${brandPath}/source`).send({ enabled: false }).expect(403);
    await viewer.agent.put(`${brandPath}/publication`).send({ enabled: false }).expect(403);
    await viewer.agent.put(`${brandPath}/threshold`).send({ dailyThresholdUsd: 1 }).expect(403);
    await db
      .update(schema.member)
      .set({ role: "admin" })
      .where(eq(schema.member.id, viewerMemberId));
    const adminOrg = await viewer.agent
      .put(orgPath)
      .send({ timezone: "UTC", dailyThresholdUsd: 3 })
      .expect(200);
    expect(adminOrg.body.revision).toBe(2);
    const adminBrand = await viewer.agent
      .put(`${brandPath}/publication`)
      .send({ enabled: false })
      .expect(200);
    expect(adminBrand.body.publicationRevision).toBe(2);

    const other = await signUp("Other");
    await createOrg(other);
    await other.agent.get(brandPath).expect(404);
    await other.agent.put(`${brandPath}/source`).send({ enabled: true }).expect(404);
  });

  it("shows organization spend and charges unattributed legacy spend to each brand", async () => {
    const owner = await signUp("SpendOwner");
    const orgId = await createOrg(owner);
    const first = (await owner.agent.post("/api/brands").send({ name: "First" }).expect(201)).body
      .id as string;
    const second = (await owner.agent.post("/api/brands").send({ name: "Second" }).expect(201)).body
      .id as string;
    await db.insert(schema.usageLedger).values([
      {
        orgId,
        brandId: first,
        step: "comment_analysis",
        provider: "google",
        modelId: "gemini-3.7-flash",
        costUsd: "0.500000",
        costSource: "price_table",
        status: "ok",
        outcome: "completed",
      },
      {
        orgId,
        step: "writer",
        provider: "google",
        modelId: "gemini-3.7-flash",
        costUsd: "0.250000",
        costSource: "price_table",
        status: "ok",
        outcome: "completed",
      },
    ]);
    expect(
      (await owner.agent.get("/api/paid-replies/organization").expect(200)).body.admittedCostUsd,
    ).toBe(0.75);
    expect(
      (await owner.agent.get(`/api/paid-replies/brands/${first}`).expect(200)).body.admittedCostUsd,
    ).toBe(0.75);
    expect(
      (await owner.agent.get(`/api/paid-replies/brands/${second}`).expect(200)).body
        .admittedCostUsd,
    ).toBe(0.25);
    const rows = await db
      .select({ id: schema.usageLedger.id })
      .from(schema.usageLedger)
      .where(
        and(eq(schema.usageLedger.orgId, orgId), eq(schema.usageLedger.costSource, "price_table")),
      );
    expect(rows).toHaveLength(2);
    await db.insert(schema.usageLedger).values({
      orgId,
      step: "writer",
      provider: "google",
      modelId: "unpriced-model",
      costSource: "unknown",
      status: "errored",
      outcome: "unknown",
    });
    expect(
      (await owner.agent.get("/api/paid-replies/organization").expect(200)).body.blockedReason,
    ).toBe("unknown_spend");
    expect(
      (await owner.agent.get(`/api/paid-replies/brands/${second}`).expect(200)).body.blockedReason,
    ).toBe("unknown_spend");
  });
});
