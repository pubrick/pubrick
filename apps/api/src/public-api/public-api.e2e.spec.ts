import { createHash } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import { MAX_ACTIVE_API_KEYS, NEXT_CURSOR_HEADER } from "@pubrick/shared";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("organization API keys and public content API", () => {
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

  async function orgAgent() {
    const agent = request.agent(app.getHttpServer());
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const signup = await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `api${suffix}@example.com`, password: "password1234", name: "Owner" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: `API ${suffix}`, slug: `api-${suffix}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return { agent, orgId: org.body.id as string, userId: signup.body.user.id as string };
  }

  async function draft(agent: request.Agent, title: string) {
    const brand = await agent.post("/api/brands").send({ name: "Example" }).expect(201);
    const channel = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Updates",
        credentials: { botToken: "123:abc", chatId: "-1001234567890" },
      })
      .expect(201);
    const item = await agent
      .post("/api/content")
      .send({
        brandId: brand.body.id,
        title,
        body: "Review me before publishing.",
        channelIds: [channel.body.id],
      })
      .expect(201);
    return item.body.id as string;
  }

  it("reveals a random secret once, stores only its hash, and rejects malformed names", async () => {
    const { agent, orgId } = await orgAgent();
    await agent.post("/api/api-keys").send({ name: " ", scope: "content:read" }).expect(400);
    await agent
      .post("/api/api-keys")
      .send({ name: "x".repeat(81), scope: "content:read" })
      .expect(400);
    const created = await agent
      .post("/api/api-keys")
      .send({ name: "Automation", scope: "content:read" })
      .expect(201);
    expect(created.headers["cache-control"]).toContain("no-store");
    expect(created.body).toMatchObject({ name: "Automation", scope: "content:read" });
    expect(created.body.key).toMatch(/^pbrk_[a-f0-9]{24}_[A-Za-z0-9_-]{43}$/);
    const listed = await agent.get("/api/api-keys").expect(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0]).toMatchObject({ name: "Automation", prefix: created.body.prefix });
    expect(listed.body[0]).not.toHaveProperty("key");
    expect(listed.body[0]).not.toHaveProperty("keyHash");
    const [stored] = await db
      .select({ hash: schema.organizationApiKeys.keyHash })
      .from(schema.organizationApiKeys)
      .where(
        and(
          eq(schema.organizationApiKeys.orgId, orgId),
          eq(schema.organizationApiKeys.id, created.body.id),
        ),
      );
    expect(stored?.hash).toBe(createHash("sha256").update(created.body.key).digest("hex"));
    expect(stored?.hash).not.toContain(created.body.key);
  });

  it("accepts only scoped bearer keys, isolates tenants, paginates, and never stamps opened", async () => {
    const mine = await orgAgent();
    const other = await orgAgent();
    const firstId = await draft(mine.agent, "First");
    const secondId = await draft(mine.agent, "Second");
    const otherId = await draft(other.agent, "Private to another organization");
    const good = await mine.agent
      .post("/api/api-keys")
      .send({ name: "Reader", scope: "content:read" })
      .expect(201);
    await mine.agent
      .post("/api/api-keys")
      .send({ name: "Unknown", scope: "analytics:read" })
      .expect(400);
    const target = request(app.getHttpServer());
    await mine.agent.get("/api/v1/content").expect(401); // cookie alone
    await target.get("/api/v1/content").expect(401);
    await target
      .get("/api/v1/content")
      .set("Authorization", `Bearer ${good.body.key}x`)
      .expect(401);
    await target.get("/api/v1/content").set("Authorization", `Basic ${good.body.key}`).expect(401);

    const one = await target
      .get("/api/v1/content?limit=1")
      .set("Authorization", `Bearer ${good.body.key}`)
      .expect(200);
    expect(one.body).toHaveLength(1);
    expect(one.body[0].id).toBe(secondId);
    expect(Object.keys(one.body[0]).sort()).toEqual(
      ["brandId", "createdAt", "id", "origin", "status", "title", "updatedAt"].sort(),
    );
    const cursor = one.headers[NEXT_CURSOR_HEADER.toLowerCase()];
    expect(typeof cursor).toBe("string");
    if (typeof cursor !== "string") throw new Error("Missing next cursor");
    const two = await target
      .get(`/api/v1/content?limit=1&cursor=${encodeURIComponent(cursor)}`)
      .set("Authorization", `Bearer ${good.body.key}`)
      .expect(200);
    expect(two.body.map((item: { id: string }) => item.id)).toEqual([firstId]);
    expect(two.headers[NEXT_CURSOR_HEADER.toLowerCase()]).toBeUndefined();
    const detail = await target
      .get(`/api/v1/content/${firstId}`)
      .set("Authorization", `Bearer ${good.body.key}`)
      .expect(200);
    expect(detail.body).toMatchObject({ id: firstId, body: "Review me before publishing." });
    expect(Object.keys(detail.body).sort()).toEqual(
      ["body", "brandId", "createdAt", "id", "origin", "status", "title", "updatedAt"].sort(),
    );
    await target
      .get(`/api/v1/content/${otherId}`)
      .set("Authorization", `Bearer ${good.body.key}`)
      .expect(404);
    const [stored] = await db
      .select({ opened: schema.contentItems.firstOpenedAt })
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, firstId));
    expect(stored?.opened).toBeNull();
    await target
      .get("/api/v1/content?limit=201")
      .set("Authorization", `Bearer ${good.body.key}`)
      .expect(400);
    await target
      .get("/api/v1/content?cursor=broken")
      .set("Authorization", `Bearer ${good.body.key}`)
      .expect(400);

    await mine.agent.delete(`/api/api-keys/${good.body.id}`).expect(204);
    await target.get("/api/v1/content").set("Authorization", `Bearer ${good.body.key}`).expect(401);
    await mine.agent.delete(`/api/api-keys/${good.body.id}`).expect(409);
    await other.agent.delete(`/api/api-keys/${good.body.id}`).expect(409);
  });

  it("restricts management to owners/admins and caps active keys", async () => {
    const { agent, orgId, userId } = await orgAgent();
    await db
      .update(schema.member)
      .set({ role: "member" })
      .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)));
    await agent.get("/api/api-keys").expect(403);
    await agent.post("/api/api-keys").send({ name: "No", scope: "content:read" }).expect(403);
    await db
      .update(schema.member)
      .set({ role: "admin" })
      .where(and(eq(schema.member.organizationId, orgId), eq(schema.member.userId, userId)));
    const first = await agent
      .post("/api/api-keys")
      .send({ name: "One", scope: "content:read" })
      .expect(201);
    for (let i = 1; i < MAX_ACTIVE_API_KEYS; i += 1) {
      await agent
        .post("/api/api-keys")
        .send({ name: `Key ${i}`, scope: "content:read" })
        .expect(201);
    }
    await agent
      .post("/api/api-keys")
      .send({ name: "Over limit", scope: "content:read" })
      .expect(409);
    await agent.delete(`/api/api-keys/${first.body.id}`).expect(204);
    await agent
      .post("/api/api-keys")
      .send({ name: "Replacement", scope: "content:read" })
      .expect(201);
  });
});
