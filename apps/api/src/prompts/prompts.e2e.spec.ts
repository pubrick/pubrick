import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("versioned prompt guidance e2e", () => {
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

  async function orgAgent() {
    const agent = request.agent(app.getHttpServer());
    const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `prompt${uniq}@example.com`, password: "password1234", name: "U" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${uniq}`, slug: `prompt-org-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return agent;
  }

  it("keeps immutable revisions per org, restores by appending, and serializes concurrent edits", async () => {
    const owner = await orgAgent();
    const other = await orgAgent();
    const path = "/api/prompts/writer/revisions";
    const first = await owner.post(path).send({ guidance: "Short sentences." }).expect(201);
    expect(first.body).toMatchObject({ role: "writer", version: 1, guidance: "Short sentences." });
    const second = await owner.post(path).send({ guidance: "Active voice." }).expect(201);
    expect(second.body.version).toBe(2);
    expect((await owner.get("/api/prompts").expect(200)).body).toMatchObject([
      { id: second.body.id, role: "writer", version: 2 },
    ]);
    expect((await other.get("/api/prompts").expect(200)).body).toEqual([]);
    expect((await other.get(path).expect(200)).body).toEqual([]);
    await other.post(path).send({ guidance: "Different tenant." }).expect(201);
    expect(
      (await owner.get(path).expect(200)).body.map((row: { guidance: string }) => row.guidance),
    ).toEqual(["Active voice.", "Short sentences."]);

    const concurrent = await Promise.all([
      owner.post(path).send({ guidance: first.body.guidance }).expect(201),
      owner.post(path).send({ guidance: "Plain language." }).expect(201),
    ]);
    expect(concurrent.map((response) => response.body.version).sort()).toEqual([3, 4]);
    expect((await owner.get(path).expect(200)).body).toHaveLength(4);
    await owner.post("/api/prompts/unknown/revisions").send({ guidance: "x" }).expect(400);
    await owner
      .post(path)
      .send({ guidance: "x".repeat(6001) })
      .expect(400);
  });
});
