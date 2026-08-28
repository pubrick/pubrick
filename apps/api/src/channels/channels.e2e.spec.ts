import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("channels e2e", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    // Migrations run once for the whole suite in vitest.global-setup.ts (a single
    // barrier, instead of six e2e files each racing runMigrations() against the
    // same DB — that redundant per-file migration dance is what caused the
    // "beforeAll hook timed out" flake).
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

  it("creates a channel and never exposes credentials", async () => {
    const agent = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "B" }).expect(201);
    const created = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Main channel",
        credentials: { botToken: "12345:secret-token", chatId: "@pubrick" },
      })
      .expect(201);
    expect(JSON.stringify(created.body)).not.toContain("secret-token");
    expect(created.body.credentialsEncrypted).toBeUndefined();

    const list = await agent.get(`/api/channels?brandId=${brand.body.id}`).expect(200);
    expect(list.body).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain("secret-token");
    expect(JSON.stringify(list.body)).not.toContain("credentials");
  });

  it("stores credentials encrypted at rest", async () => {
    const agent = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "B2" }).expect(201);
    await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "vk",
        name: "VK",
        credentials: { accessToken: "vk-plain-secret" },
      })
      .expect(201);
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const rows = await db.execute(
      "SELECT credentials_encrypted FROM channels ORDER BY created_at DESC LIMIT 1",
    );
    await pool.end();
    const stored = String((rows.rows[0] as Record<string, unknown>).credentials_encrypted);
    expect(stored).not.toContain("vk-plain-secret");
  });

  it("rejects a channel for another org's brand", async () => {
    const a = await orgAgent();
    const b = await orgAgent();
    const brandA = await a.post("/api/brands").send({ name: "A brand" }).expect(201);
    await b
      .post("/api/channels")
      .send({ brandId: brandA.body.id, platform: "telegram", name: "X", credentials: { t: "1" } })
      .expect(404);
  });

  it("deletes org-scoped", async () => {
    const a = await orgAgent();
    const brand = await a.post("/api/brands").send({ name: "D" }).expect(201);
    const ch = await a
      .post("/api/channels")
      .send({ brandId: brand.body.id, platform: "max", name: "M", credentials: { k: "v" } })
      .expect(201);
    const b = await orgAgent();
    await b.delete(`/api/channels/${ch.body.id}`).expect(404);
    await a.delete(`/api/channels/${ch.body.id}`).expect(200);
  });
});
