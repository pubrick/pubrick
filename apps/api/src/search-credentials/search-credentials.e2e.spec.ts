import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import { decryptJson, searchCredentialPublicSchema } from "@pubrick/shared";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const ENCRYPTION_KEY = "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
const SECRET = "search-key-never-send-back-123456";

describe.skipIf(!url)("search credentials e2e", () => {
  let app: INestApplication;
  let direct: ReturnType<typeof createDb>;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= ENCRYPTION_KEY;
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

  async function signUp(name: string) {
    const agent = request.agent(app.getHttpServer());
    const suffix = randomUUID();
    const signed = await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `${name}-${suffix}@example.com`, password: "password1234", name })
      .expect(200);
    return { agent, userId: signed.body.user.id as string };
  }

  async function orgAgent(name: string) {
    const signed = await signUp(name);
    const created = await signed.agent
      .post("/api/auth/organization/create")
      .send({ name, slug: `${name.toLowerCase()}-${randomUUID()}` })
      .expect(200);
    await signed.agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: created.body.id })
      .expect(200);
    return { ...signed, orgId: created.body.id as string };
  }

  it("encrypts and replaces one organization key, isolates tenants, and enforces manager access", async () => {
    const owner = await orgAgent("SearchOwner");
    const stranger = await orgAgent("SearchStranger");
    const member = await signUp("SearchMember");
    await direct.db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: owner.orgId,
      userId: member.userId,
      role: "member",
    });
    await member.agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: owner.orgId })
      .expect(200);

    const empty = (await owner.agent.get("/api/search-credentials").expect(200)).body;
    expect(searchCredentialPublicSchema.parse(empty)).toEqual({
      configured: false,
      folderId: null,
      updatedAt: null,
    });
    await member.agent.get("/api/search-credentials").expect(403);
    await member.agent
      .put("/api/search-credentials")
      .send({ apiKey: SECRET, folderId: "b1g-folder" })
      .expect(403);
    await member.agent.delete("/api/search-credentials").expect(403);
    await owner.agent
      .put("/api/search-credentials")
      .send({ apiKey: "short", folderId: "b1g-folder" })
      .expect(400);

    const saved = (
      await owner.agent
        .put("/api/search-credentials")
        .send({ apiKey: SECRET, folderId: "b1g-folder" })
        .expect(200)
    ).body;
    expect(searchCredentialPublicSchema.parse(saved)).toEqual(saved);
    expect(saved).toMatchObject({ configured: true, folderId: "b1g-folder" });
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    expect(
      JSON.stringify((await owner.agent.get("/api/search-credentials").expect(200)).body),
    ).not.toContain(SECRET);
    expect((await stranger.agent.get("/api/search-credentials").expect(200)).body).toEqual(empty);

    const [stored] = await direct.db
      .select({ credentialsEncrypted: schema.searchCredentials.credentialsEncrypted })
      .from(schema.searchCredentials)
      .where(eq(schema.searchCredentials.orgId, owner.orgId));
    expect(stored?.credentialsEncrypted).toMatch(/^p[0-9]\./);
    expect(stored?.credentialsEncrypted).not.toContain(SECRET);
    expect(decryptJson(stored?.credentialsEncrypted as string, ENCRYPTION_KEY)).toEqual({
      apiKey: SECRET,
    });

    const replacement = "replacement-search-key-987654321";
    const replaced = (
      await owner.agent
        .put("/api/search-credentials")
        .send({ apiKey: replacement, folderId: "new-folder" })
        .expect(200)
    ).body;
    expect(replaced.folderId).toBe("new-folder");
    const rows = await direct.db
      .select({ encrypted: schema.searchCredentials.credentialsEncrypted })
      .from(schema.searchCredentials)
      .where(eq(schema.searchCredentials.orgId, owner.orgId));
    expect(rows).toHaveLength(1);
    expect(decryptJson(rows[0]?.encrypted as string, ENCRYPTION_KEY)).toEqual({
      apiKey: replacement,
    });
    expect((await stranger.agent.delete("/api/search-credentials").expect(204)).text).toBe("");
    expect((await owner.agent.delete("/api/search-credentials").expect(204)).text).toBe("");
    expect((await owner.agent.get("/api/search-credentials").expect(200)).body).toEqual(empty);
  });

  it("persists attempted requests with org FK, bounded status, and consistent completion", async () => {
    const owner = await orgAgent("SearchLedger");
    const [attempt] = await direct.db
      .insert(schema.searchRequests)
      .values({ orgId: owner.orgId })
      .returning({ id: schema.searchRequests.id });
    expect(attempt?.id).toBeDefined();
    await expect(
      direct.db.execute(
        sql`UPDATE search_requests SET status = 'unknown' WHERE id = ${attempt?.id}`,
      ),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      direct.db.execute(
        sql`UPDATE search_requests SET status = 'succeeded' WHERE id = ${attempt?.id}`,
      ),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await direct.db
      .update(schema.searchRequests)
      .set({ status: "succeeded", completedAt: new Date() })
      .where(eq(schema.searchRequests.id, attempt?.id as string));
    await expect(
      direct.db.insert(schema.searchRequests).values({ orgId: "missing-org" }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });
});
