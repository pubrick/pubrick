import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("brands e2e", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const { runMigrations } = await import("@pubrick/db");
    await runMigrations(url as string);
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  async function orgAgent(): Promise<request.Agent> {
    const agent = request.agent(app.getHttpServer());
    const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `u${uniq}@example.com`, password: "password1234", name: "U" })
      .expect(200);
    const created = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${uniq}`, slug: `org-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: created.body.id })
      .expect(200);
    return agent;
  }

  it("creates, lists, updates and deletes a brand", async () => {
    const agent = await orgAgent();
    const created = await agent
      .post("/api/brands")
      .send({ name: "DOMI", contentLanguage: "ru" })
      .expect(201);
    expect(created.body.name).toBe("DOMI");

    const list = await agent.get("/api/brands").expect(200);
    expect(list.body).toHaveLength(1);

    const updated = await agent
      .patch(`/api/brands/${created.body.id}`)
      .send({ voice: "friendly expert" })
      .expect(200);
    expect(updated.body.voice).toBe("friendly expert");

    await agent.delete(`/api/brands/${created.body.id}`).expect(200);
    const after = await agent.get("/api/brands").expect(200);
    expect(after.body).toHaveLength(0);
  });

  it("rejects invalid payloads with 400", async () => {
    const agent = await orgAgent();
    await agent.post("/api/brands").send({ name: "" }).expect(400);
  });

  it("isolates brands between organizations", async () => {
    const a = await orgAgent();
    const b = await orgAgent();
    const created = await a.post("/api/brands").send({ name: "Only A" }).expect(201);
    const listB = await b.get("/api/brands").expect(200);
    expect(listB.body).toHaveLength(0);
    await b.get(`/api/brands/${created.body.id}`).expect(404);
    await b.delete(`/api/brands/${created.body.id}`).expect(404);
  });

  it("blocks cross-org PATCH and leaves the brand untouched", async () => {
    const a = await orgAgent();
    const b = await orgAgent();
    const created = await a.post("/api/brands").send({ name: "Only A", voice: "calm" }).expect(201);

    await b
      .patch(`/api/brands/${created.body.id}`)
      .send({ name: "Hijacked", voice: "loud" })
      .expect(404);

    const stillA = await a.get(`/api/brands/${created.body.id}`).expect(200);
    expect(stillA.body.name).toBe("Only A");
    expect(stillA.body.voice).toBe("calm");
  });
});
