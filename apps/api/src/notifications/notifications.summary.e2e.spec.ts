import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import { notificationSummarySchema } from "@pubrick/shared";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("notification summary API", () => {
  let app: INestApplication;
  let direct: ReturnType<typeof createDb>;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    direct = createDb(url as string);
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await direct?.pool.end();
  });

  async function signUp() {
    const agent = request.agent(app.getHttpServer());
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const signed = await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `summary${suffix}@example.com`, password: "password1234", name: "Reader" })
      .expect(200);
    return { agent, userId: signed.body.user.id as string };
  }

  async function createOrg(person: Awaited<ReturnType<typeof signUp>>) {
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const created = await person.agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${suffix}`, slug: `summary-org-${suffix}` })
      .expect(200);
    await person.agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: created.body.id })
      .expect(200);
    return created.body.id as string;
  }

  it("allows managers, refuses members, validates days, and cannot read another org", async () => {
    const owner = await signUp();
    const orgId = await createOrg(owner);
    const member = await signUp();
    await direct.db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: orgId,
      userId: member.userId,
      role: "member",
    });
    await member.agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    const foreignOwner = await signUp();
    const foreignOrgId = await createOrg(foreignOwner);
    for (const ownedOrgId of [orgId, foreignOrgId]) {
      await direct.db.insert(schema.notificationEvents).values({
        orgId: ownedOrgId,
        event: "delivery_unknown",
        subjectId: randomUUID(),
        targetId: randomUUID(),
        status: "attempted",
        reason: "delivery_unconfirmed",
      });
    }
    const route = "/api/notifications/summary";
    const own = await owner.agent.get(`${route}?days=7`).expect(200);
    expect(notificationSummarySchema.parse(own.body)).toEqual(own.body);
    expect(own.body.total).toBe(1);
    expect(own.body.byStatus.attempted).toBe(1);
    expect(Object.keys(own.body).sort()).toEqual(
      [
        "byEvent",
        "byReason",
        "byStatus",
        "days",
        "total",
        "windowEnd",
        "windowStart",
        "withoutReason",
      ].sort(),
    );
    await member.agent.get(route).expect(403);
    await owner.agent.get(`${route}?days=8`).expect(400);
    const foreign = await foreignOwner.agent.get(`${route}?days=30`).expect(200);
    expect(foreign.body.total).toBe(1);
    expect(foreign.body.days).toBe(30);
  });
});
