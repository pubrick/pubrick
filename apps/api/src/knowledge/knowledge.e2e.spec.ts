import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { embedKnowledgeText } from "@pubrick/ai";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@pubrick/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pubrick/ai")>();
  return { ...actual, embedKnowledgeText: vi.fn() };
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("knowledge e2e", () => {
  let app: INestApplication;
  let db: Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["db"];
  let pool: Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["pool"];
  let schema: typeof import("@pubrick/db").schema;
  let eq: typeof import("drizzle-orm").eq;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const dbModule = await import("@pubrick/db");
    schema = dbModule.schema;
    ({ db, pool } = dbModule.createDb(url as string));
    ({ eq } = await import("drizzle-orm"));
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
    const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `knowledge${uniq}@example.com`, password: "password1234", name: "U" })
      .expect(200);
    const created = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Knowledge ${uniq}`, slug: `knowledge-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: created.body.id })
      .expect(200);
    return { agent, orgId: created.body.id as string };
  }

  it("scopes every mutation to both organization and brand, and clears edited vectors", async () => {
    const { agent: owner, orgId: ownerOrgId } = await orgAgent();
    const { agent: outsider } = await orgAgent();
    const brand = await owner.post("/api/brands").send({ name: "Coffee" }).expect(201);
    const otherBrand = await owner.post("/api/brands").send({ name: "Shoes" }).expect(201);
    const entry = await owner
      .post("/api/knowledge")
      .send({
        brandId: brand.body.id,
        title: "Espresso",
        content: "Only Arabica beans.",
        category: "product_info",
        tags: ["coffee"],
      })
      .expect(201);
    expect(entry.body.hasEmbedding).toBe(false);
    await expect(
      pool.query("UPDATE knowledge_entries SET category = 'bogus' WHERE id = $1", [entry.body.id]),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      (await owner.get(`/api/knowledge?brandId=${brand.body.id}`).expect(200)).body,
    ).toHaveLength(1);
    expect(
      (await owner.get(`/api/knowledge?brandId=${otherBrand.body.id}`).expect(200)).body,
    ).toHaveLength(0);
    expect(
      (await outsider.get(`/api/knowledge?brandId=${brand.body.id}`).expect(200)).body,
    ).toHaveLength(0);
    await outsider
      .patch(`/api/knowledge/${entry.body.id}?brandId=${brand.body.id}`)
      .send({ title: "Stolen" })
      .expect(404);
    await owner.delete(`/api/knowledge/${entry.body.id}?brandId=${otherBrand.body.id}`).expect(404);

    // A vector for old text must not survive a content edit. The API never
    // returns the 768 numbers; only their presence is observable.
    await db
      .update(schema.knowledgeEntries)
      .set({ embedding: Array(768).fill(0.1) })
      .where(eq(schema.knowledgeEntries.id, entry.body.id));
    const indexed = await owner
      .get(`/api/knowledge/${entry.body.id}?brandId=${brand.body.id}`)
      .expect(200);
    expect(indexed.body.hasEmbedding).toBe(true);
    const paused = await owner
      .patch(`/api/knowledge/${entry.body.id}?brandId=${brand.body.id}`)
      .send({ isActive: false })
      .expect(200);
    expect(paused.body.hasEmbedding).toBe(true);
    const edited = await owner
      .patch(`/api/knowledge/${entry.body.id}?brandId=${brand.body.id}`)
      .send({ content: "Only Robusta beans." })
      .expect(200);
    expect(edited.body.hasEmbedding).toBe(false);
    expect(edited.body.content).toBe("Only Robusta beans.");
    const { KnowledgeRepository } = await import("./knowledge.repository");
    expect(
      await new KnowledgeRepository().setEmbedding(
        ownerOrgId,
        brand.body.id,
        entry.body.id,
        "Espresso",
        "Only Arabica beans.",
        Array(768).fill(0.1),
      ),
    ).toBeUndefined();
    const noKey = await owner
      .post(`/api/knowledge/${entry.body.id}/index?brandId=${brand.body.id}`)
      .expect(201);
    expect(noKey.body).toEqual({ indexed: false, reason: "google_key_required" });
  });

  it("indexes with the organization's Google key and records the unpriced call", async () => {
    const { agent, orgId } = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Tea" }).expect(201);
    const { encryptJson } = await import("@pubrick/shared");
    await db.insert(schema.aiCredentials).values({
      orgId,
      provider: "google",
      credentialsEncrypted: encryptJson(
        { apiKey: "fake-provider-key" },
        process.env.APP_ENCRYPTION_KEY as string,
      ),
    });
    const note = await agent
      .post("/api/knowledge")
      .send({
        brandId: brand.body.id,
        title: "Green tea",
        content: "Our tea is roasted.",
        category: "product_info",
      })
      .expect(201);
    vi.mocked(embedKnowledgeText).mockResolvedValueOnce({
      embedding: Array(768).fill(0.1),
      tokens: 12,
    });
    const indexed = await agent
      .post(`/api/knowledge/${note.body.id}/index?brandId=${brand.body.id}`)
      .expect(201);
    expect(indexed.body.indexed).toBe(true);
    expect(indexed.body.entry.hasEmbedding).toBe(true);
    expect(indexed.body.entry).not.toHaveProperty("embedding");
    expect(embedKnowledgeText).toHaveBeenCalledWith(
      "fake-provider-key",
      "Green tea\n\nOur tea is roasted.",
      "RETRIEVAL_DOCUMENT",
    );
    const ledger = await db
      .select({
        inputTokens: schema.usageLedger.inputTokens,
        costSource: schema.usageLedger.costSource,
      })
      .from(schema.usageLedger)
      .where(eq(schema.usageLedger.orgId, orgId));
    expect(ledger).toEqual([{ inputTokens: 12, costSource: "unknown" }]);
  });

  it("imports a validated CSV batch atomically and keeps it inside the brand", async () => {
    const { agent: owner } = await orgAgent();
    const { agent: outsider } = await orgAgent();
    const brand = await owner.post("/api/brands").send({ name: "Books" }).expect(201);
    const entries = [
      { title: "Binding", content: "Sewn binding", category: "product_info", tags: ["books"] },
      { title: "Voice", content: "Use a warm tone", category: "brand_guidelines", tags: [] },
    ];
    const imported = await owner
      .post("/api/knowledge/bulk-import")
      .send({ brandId: brand.body.id, entries })
      .expect(201);
    expect(imported.body.created).toBe(2);
    expect(imported.body.ids).toHaveLength(2);
    const own = await owner.get(`/api/knowledge?brandId=${brand.body.id}`).expect(200);
    expect(own.body.map((entry: { title: string }) => entry.title).sort()).toEqual([
      "Binding",
      "Voice",
    ]);
    expect(own.body.every((entry: { hasEmbedding: boolean }) => !entry.hasEmbedding)).toBe(true);
    expect(
      (await outsider.get(`/api/knowledge?brandId=${brand.body.id}`).expect(200)).body,
    ).toEqual([]);
    await outsider
      .post("/api/knowledge/bulk-import")
      .send({ brandId: brand.body.id, entries })
      .expect(404);
    await owner
      .post("/api/knowledge/bulk-import")
      .send({
        brandId: brand.body.id,
        entries: [...entries, { ...entries[0], category: "unknown" }],
      })
      .expect(400);
    expect(
      (await owner.get(`/api/knowledge?brandId=${brand.body.id}`).expect(200)).body,
    ).toHaveLength(2);
  });
});
