import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schema } from "@pubrick/db";
import { autopilotScanPageSchema } from "@pubrick/shared";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("scheduled Autopilot history API", () => {
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
    await app?.close();
  });

  async function actor() {
    const agent = request.agent(app.getHttpServer());
    const uniq = randomUUID();
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `scan-${uniq}@example.com`, password: "password1234", name: "Owner" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${uniq}`, slug: `scan-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    const brand = await agent.post("/api/brands").send({ name: "Brand" }).expect(201);
    return { agent, orgId: org.body.id as string, brandId: brand.body.id as string };
  }

  it("scopes cursor pagination and status filters to the active organization and brand", async () => {
    const owner = await actor();
    const outsider = await actor();
    const otherBrand = await owner.agent.post("/api/brands").send({ name: "Other" }).expect(201);
    const times = ["2026-09-25T10:00:00Z", "2026-09-25T10:01:00Z", "2026-09-25T10:02:00Z"];
    for (const [index, value] of times.entries()) {
      await db.insert(schema.autopilotScanEvents).values({
        orgId: owner.orgId,
        brandId: owner.brandId,
        scanJobId: randomUUID(),
        status: index === 1 ? "failed" : "skipped",
        decision: index === 1 ? "worker_failed" : "no_approved_topic",
        startedAt: new Date(value),
        finishedAt: new Date(value),
      });
    }
    const [foreign] = await db
      .insert(schema.autopilotScanEvents)
      .values({
        orgId: owner.orgId,
        brandId: otherBrand.body.id,
        scanJobId: randomUUID(),
        status: "skipped",
        decision: "no_approved_topic",
        startedAt: new Date(),
        finishedAt: new Date(),
      })
      .returning({ id: schema.autopilotScanEvents.id });
    const path = `/api/brands/${owner.brandId}/autopilot/scans`;
    await outsider.agent.get(path).expect(404);
    const first = autopilotScanPageSchema.parse(
      (await owner.agent.get(`${path}?limit=1`).expect(200)).body,
    );
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0]?.finishedAt).toBe("2026-09-25T10:02:00.000Z");
    const second = autopilotScanPageSchema.parse(
      (await owner.agent.get(`${path}?limit=1&cursor=${first.nextCursor}`).expect(200)).body,
    );
    expect(second.rows[0]?.status).toBe("failed");
    const failed = autopilotScanPageSchema.parse(
      (await owner.agent.get(`${path}?status=failed`).expect(200)).body,
    );
    expect(failed.rows).toHaveLength(1);
    await owner.agent.get(`${path}?status=skipped&cursor=${second.rows[0]?.id}`).expect(400);
    await owner.agent.get(`${path}?cursor=${foreign?.id}`).expect(400);
    await owner.agent.get(`${path}?limit=101`).expect(400);
    await db
      .delete(schema.autopilotScanEvents)
      .where(eq(schema.autopilotScanEvents.orgId, owner.orgId));
  });
});
