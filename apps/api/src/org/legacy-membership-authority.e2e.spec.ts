import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("real legacy duplicate membership authority", () => {
  let app: INestApplication;
  let connection: ReturnType<typeof createDb>;
  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    connection = createDb(url as string);
  });
  afterAll(async () => {
    await app.close();
    await connection.pool.end();
  });
  async function fixture() {
    const agent = request.agent(app.getHttpServer());
    const unique = randomUUID();
    const signup = await agent
      .post("/api/auth/sign-up/email")
      .send({
        name: "Legacy owner",
        email: `legacy-${unique}@example.com`,
        password: "password1234",
      })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: "Legacy organization", slug: unique })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    const userId = signup.body.user.id as string;
    const orgId = org.body.id as string;
    // The earlier physical tuple has only author; the later legacy duplicate restores owner.
    await connection.db
      .update(schema.member)
      .set({ role: "author" })
      .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)));
    await connection.db
      .insert(schema.member)
      .values({ id: randomUUID(), organizationId: orgId, userId, role: "owner" });
    return { agent, orgId, userId, legacyId };
  }
  it("allows both manager creation and brand-scoped manager/read routes with the owner in a later row", async () => {
    const f = await fixture();
    const brand = await f.agent
      .post("/api/brands")
      .send({ name: "Legacy scoped brand" })
      .expect(201);
    await f.agent.get(`/api/brands/${brand.body.id}`).expect(200);
    await f.agent.get(`/api/brands/${brand.body.id}/access`).expect(200);
    const listed = await f.agent.get("/api/brands").expect(200);
    expect(listed.body.some((row: { id: string }) => row.id === brand.body.id)).toBe(true);
    expect(
      await connection.db
        .select({ id: schema.member.id })
        .from(schema.member)
        .where(and(eq(schema.member.organizationId, f.orgId), eq(schema.member.userId, f.userId))),
    ).toHaveLength(2);
  });
  it("unions grants on later editorial membership rows without widening manager permissions", async () => {
    const f = await fixture();
    const brand = await f.agent
      .post("/api/brands")
      .send({ name: "Editorial legacy brand" })
      .expect(201);
    await connection.db
      .update(schema.member)
      .set({ role: "editor" })
      .where(eq(schema.member.id, f.legacyId));
    await connection.db
      .insert(schema.brandAccess)
      .values({ orgId: f.orgId, brandId: brand.body.id, memberId: f.legacyId });
    await f.agent.get(`/api/brands/${brand.body.id}`).expect(200);
    const listed = await f.agent.get("/api/brands").expect(200);
    expect(listed.body.filter((row: { id: string }) => row.id === brand.body.id)).toHaveLength(1);
    await f.agent.get(`/api/brands/${brand.body.id}/access`).expect(403);
  });
  it("does not borrow another organization or account's owner role", async () => {
    const f = await fixture();
    const other = await fixture();
    await connection.db
      .update(schema.member)
      .set({ role: "author" })
      .where(and(eq(schema.member.organizationId, f.orgId), eq(schema.member.userId, f.userId)));
    await connection.db
      .insert(schema.member)
      .values({ id: randomUUID(), organizationId: other.orgId, userId: f.userId, role: "owner" });
    await f.agent.post("/api/brands").send({ name: "Forbidden" }).expect(403);
    expect(
      await connection.db
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(eq(schema.brands.orgId, f.orgId)),
    ).toHaveLength(0);
  });
});
