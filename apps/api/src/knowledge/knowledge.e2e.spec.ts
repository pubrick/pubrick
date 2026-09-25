import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { embedKnowledgeBatch, embedKnowledgeText } from "@pubrick/ai";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@pubrick/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pubrick/ai")>();
  return { ...actual, embedKnowledgeText: vi.fn(), embedKnowledgeBatch: vi.fn() };
});

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("knowledge e2e", () => {
  beforeEach(() => vi.clearAllMocks());
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
    for (const category of ["bad\ncategory", "bad\u0085category", "x".repeat(101), " padded "]) {
      await expect(
        pool.query("UPDATE knowledge_entries SET category = $1 WHERE id = $2", [
          category,
          entry.body.id,
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    }
    expect(
      (await owner.get(`/api/knowledge?brandId=${brand.body.id}`).expect(200)).body,
    ).toHaveLength(1);
    expect(
      (await owner.get(`/api/knowledge?brandId=${otherBrand.body.id}`).expect(200)).body,
    ).toHaveLength(0);
    await outsider.get(`/api/knowledge?brandId=${brand.body.id}`).expect(404);
    await outsider
      .patch(`/api/knowledge/${entry.body.id}?brandId=${brand.body.id}`)
      .send({ title: "Stolen" })
      .expect(404);
    await owner.delete(`/api/knowledge/${entry.body.id}?brandId=${otherBrand.body.id}`).expect(404);

    // A vector for old text must not survive a content edit. The API never
    // returns the 768 numbers; only their presence is observable.
    await db
      .update(schema.knowledgeEntries)
      .set({
        embedding: Array(768).fill(0.1),
        embeddingModel: "gemini-embedding-001",
        embeddingDimensions: 768,
      })
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
    const recategorized = await owner
      .patch(`/api/knowledge/${entry.body.id}?brandId=${brand.body.id}`)
      .send({ category: "  Retail Partners  " })
      .expect(200);
    expect(recategorized.body.category).toBe("Retail Partners");
    expect(recategorized.body.hasEmbedding).toBe(true);
    expect(
      (
        await owner
          .get(`/api/knowledge?brandId=${brand.body.id}&category=Retail%20Partners`)
          .expect(200)
      ).body.map((note: { id: string }) => note.id),
    ).toContain(entry.body.id);
    expect(
      (
        await owner
          .get(`/api/knowledge?brandId=${otherBrand.body.id}&category=Retail%20Partners`)
          .expect(200)
      ).body,
    ).toEqual([]);
    await outsider
      .get(`/api/knowledge?brandId=${brand.body.id}&category=Retail%20Partners`)
      .expect(404);
    await owner.get(`/api/knowledge?brandId=${brand.body.id}&category=bad%0Acategory`).expect(400);
    const edited = await owner
      .patch(`/api/knowledge/${entry.body.id}?brandId=${brand.body.id}`)
      .send({ content: "Only Robusta beans." })
      .expect(200);
    expect(edited.body.hasEmbedding).toBe(false);
    expect(edited.body.content).toBe("Only Robusta beans.");
    const [cleared] = await db
      .select({
        model: schema.knowledgeEntries.embeddingModel,
        dimensions: schema.knowledgeEntries.embeddingDimensions,
      })
      .from(schema.knowledgeEntries)
      .where(eq(schema.knowledgeEntries.id, entry.body.id));
    expect(cleared).toEqual({ model: null, dimensions: null });
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
    const [provenance] = await db
      .select({
        model: schema.knowledgeEntries.embeddingModel,
        dimensions: schema.knowledgeEntries.embeddingDimensions,
      })
      .from(schema.knowledgeEntries)
      .where(eq(schema.knowledgeEntries.id, note.body.id));
    expect(provenance).toEqual({ model: "gemini-embedding-001", dimensions: 768 });
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
      {
        title: "Voice",
        content: "Use a warm tone",
        category: "brand_guidelines",
        tags: ["coffee, roasted", "bulk|B2B"],
        isActive: false,
      },
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
      own.body
        .map((entry: { title: string; tags: string[]; isActive: boolean }) => ({
          title: entry.title,
          tags: entry.tags,
          isActive: entry.isActive,
        }))
        .sort((a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title)),
    ).toEqual([
      { title: "Binding", tags: ["books"], isActive: true },
      { title: "Voice", tags: ["coffee, roasted", "bulk|B2B"], isActive: false },
    ]);
    await outsider.get(`/api/knowledge?brandId=${brand.body.id}`).expect(404);
    await outsider
      .post("/api/knowledge/bulk-import")
      .send({ brandId: brand.body.id, entries })
      .expect(404);
    await owner
      .post("/api/knowledge/bulk-import")
      .send({
        brandId: brand.body.id,
        entries: [...entries, { ...entries[0], category: "invalid\u0000category" }],
      })
      .expect(400);
    await owner
      .post("/api/knowledge/bulk-import")
      .send({
        brandId: brand.body.id,
        entries: [...entries, { ...entries[0], isActive: "false" }],
      })
      .expect(400);
    expect(
      (await owner.get(`/api/knowledge?brandId=${brand.body.id}`).expect(200)).body,
    ).toHaveLength(2);
  });

  it("indexes only active unindexed notes in one metered batch and does not spend on repeat", async () => {
    const { agent, orgId } = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Batch" }).expect(201);
    const { encryptJson } = await import("@pubrick/shared");
    await db.insert(schema.aiCredentials).values({
      orgId,
      provider: "google",
      credentialsEncrypted: encryptJson(
        { apiKey: "fake-provider-key" },
        process.env.APP_ENCRYPTION_KEY as string,
      ),
    });
    const entries = Array.from({ length: 12 }, (_, i) => ({
      title: `Note ${i}`,
      content: `Fact ${i}`,
      category: "product_info",
    }));
    await agent
      .post("/api/knowledge/bulk-import")
      .send({ brandId: brand.body.id, entries })
      .expect(201);
    const notes = (await agent.get(`/api/knowledge?brandId=${brand.body.id}`).expect(200)).body;
    await agent
      .patch(`/api/knowledge/${notes[0].id}?brandId=${brand.body.id}`)
      .send({ isActive: false })
      .expect(200);
    expect(
      (await agent.get(`/api/knowledge/index-summary?brandId=${brand.body.id}`).expect(200)).body
        .remaining,
    ).toBe(11);
    vi.mocked(embedKnowledgeBatch)
      .mockResolvedValueOnce({
        embeddings: Array.from({ length: 10 }, () => Array(768).fill(0.2)),
        tokens: 0,
        tokensKnown: false,
      })
      .mockResolvedValueOnce({ embeddings: [Array(768).fill(0.2)], tokens: 0, tokensKnown: false });
    const first = await agent
      .post("/api/knowledge/index-batch")
      .send({ brandId: brand.body.id })
      .expect(201);
    expect(first.body).toMatchObject({
      selected: 10,
      indexed: 10,
      remaining: 1,
      usageRecorded: true,
      tokensKnown: false,
    });
    expect(vi.mocked(embedKnowledgeBatch).mock.calls.at(-1)?.[1]).toHaveLength(10);
    const second = await agent
      .post("/api/knowledge/index-batch")
      .send({ brandId: brand.body.id })
      .expect(201);
    expect(second.body).toMatchObject({ selected: 1, indexed: 1, remaining: 0 });
    const callCount = vi.mocked(embedKnowledgeBatch).mock.calls.length;
    const third = await agent
      .post("/api/knowledge/index-batch")
      .send({ brandId: brand.body.id })
      .expect(201);
    expect(third.body.reason).toBe("nothing_to_index");
    expect(embedKnowledgeBatch).toHaveBeenCalledTimes(callCount);
    const ledger = await db
      .select({ step: schema.usageLedger.step, inputTokens: schema.usageLedger.inputTokens })
      .from(schema.usageLedger)
      .where(eq(schema.usageLedger.orgId, orgId));
    expect(ledger).toEqual([
      { step: "knowledge_batch_index", inputTokens: 0 },
      { step: "knowledge_batch_index", inputTokens: 0 },
    ]);
    const paused = await agent
      .get(`/api/knowledge/${notes[0].id}?brandId=${brand.body.id}`)
      .expect(200);
    expect(paused.body.hasEmbedding).toBe(false);
  });

  it("rejects another organization's brand and a changed note; saves valid vectors beside invalid ones", async () => {
    const { agent, orgId } = await orgAgent();
    const { agent: outsider } = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Scoped" }).expect(201);
    await outsider.post("/api/knowledge/index-batch").send({ brandId: brand.body.id }).expect(404);
    const { encryptJson } = await import("@pubrick/shared");
    await db.insert(schema.aiCredentials).values({
      orgId,
      provider: "google",
      credentialsEncrypted: encryptJson(
        { apiKey: "fake-provider-key" },
        process.env.APP_ENCRYPTION_KEY as string,
      ),
    });
    await agent
      .post("/api/knowledge/bulk-import")
      .send({
        brandId: brand.body.id,
        entries: [
          { title: "First", content: "Old", category: "product_info" },
          { title: "Second", content: "Other", category: "product_info" },
        ],
      })
      .expect(201);
    let resolveEmbedding!: (value: Awaited<ReturnType<typeof embedKnowledgeBatch>>) => void;
    vi.mocked(embedKnowledgeBatch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveEmbedding = resolve;
        }),
    );
    const pending = agent.post("/api/knowledge/index-batch").send({ brandId: brand.body.id });
    const response = pending.then((value) => value);
    for (let attempt = 0; attempt < 100 && !resolveEmbedding; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resolveEmbedding).toBeDefined();
    const concurrent = await agent
      .post("/api/knowledge/index-batch")
      .send({ brandId: brand.body.id })
      .expect(201);
    expect(concurrent.body.reason).toBe("already_running");
    expect(embedKnowledgeBatch).toHaveBeenCalledTimes(1);
    const firstText = vi.mocked(embedKnowledgeBatch).mock.calls.at(-1)?.[1][0];
    const firstTitle = firstText?.split("\n\n")[0];
    const notes = (await agent.get(`/api/knowledge?brandId=${brand.body.id}`).expect(200)).body;
    const selectedFirst = notes.find((note: { title: string }) => note.title === firstTitle);
    expect(selectedFirst).toBeDefined();
    await agent
      .patch(`/api/knowledge/${selectedFirst.id}?brandId=${brand.body.id}`)
      .send({ content: "New" })
      .expect(200);
    resolveEmbedding({ embeddings: [Array(768).fill(0.3), null], tokens: 0, tokensKnown: false });
    const result = await response;
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({
      selected: 2,
      indexed: 0,
      changed: 1,
      invalid: 1,
      remaining: 2,
    });
    expect(
      (await agent.get(`/api/knowledge?brandId=${brand.body.id}`).expect(200)).body.every(
        (entry: { hasEmbedding: boolean }) => !entry.hasEmbedding,
      ),
    ).toBe(true);
  });

  it("requires owner or admin for batch spend and records a failed provider attempt", async () => {
    const { agent, orgId } = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Failure" }).expect(201);
    await agent
      .post("/api/knowledge/bulk-import")
      .send({
        brandId: brand.body.id,
        entries: [{ title: "Fact", content: "Value", category: "product_info" }],
      })
      .expect(201);
    await db
      .update(schema.member)
      .set({ role: "member" })
      .where(eq(schema.member.organizationId, orgId));
    await agent.post("/api/knowledge/index-batch").send({ brandId: brand.body.id }).expect(403);
    expect(embedKnowledgeBatch).not.toHaveBeenCalled();
    await db
      .update(schema.member)
      .set({ role: "owner" })
      .where(eq(schema.member.organizationId, orgId));
    const { encryptJson } = await import("@pubrick/shared");
    await db.insert(schema.aiCredentials).values({
      orgId,
      provider: "google",
      credentialsEncrypted: encryptJson(
        { apiKey: "fake-provider-key" },
        process.env.APP_ENCRYPTION_KEY as string,
      ),
    });
    vi.mocked(embedKnowledgeBatch).mockRejectedValueOnce(new Error("provider failed"));
    const failed = await agent
      .post("/api/knowledge/index-batch")
      .send({ brandId: brand.body.id })
      .expect(201);
    expect(failed.body).toMatchObject({
      reason: "provider_unavailable",
      indexed: 0,
      remaining: 1,
      usageRecorded: true,
    });
    const ledger = await db
      .select({ step: schema.usageLedger.step, status: schema.usageLedger.status })
      .from(schema.usageLedger)
      .where(eq(schema.usageLedger.orgId, orgId));
    expect(ledger).toEqual([{ step: "knowledge_batch_index", status: "errored" }]);
  });

  it("keeps background indexing off until an owner enables it for this brand", async () => {
    const { agent, orgId } = await orgAgent();
    const { agent: outsider } = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Auto" }).expect(201);
    expect(
      (await agent.get(`/api/knowledge/auto-index?brandId=${brand.body.id}`).expect(200)).body,
    ).toEqual({ enabled: false, lastAttemptAt: null });
    await outsider.get(`/api/knowledge/auto-index?brandId=${brand.body.id}`).expect(404);
    await outsider
      .patch("/api/knowledge/auto-index")
      .send({ brandId: brand.body.id, enabled: true })
      .expect(404);
    await db
      .update(schema.member)
      .set({ role: "member" })
      .where(eq(schema.member.organizationId, orgId));
    await agent
      .patch("/api/knowledge/auto-index")
      .send({ brandId: brand.body.id, enabled: true })
      .expect(403);
    await db
      .update(schema.member)
      .set({ role: "owner" })
      .where(eq(schema.member.organizationId, orgId));
    expect(
      (
        await agent
          .patch("/api/knowledge/auto-index")
          .send({ brandId: brand.body.id, enabled: true })
          .expect(200)
      ).body.enabled,
    ).toBe(true);
    expect(
      (await agent.get(`/api/knowledge/auto-index?brandId=${brand.body.id}`).expect(200)).body
        .enabled,
    ).toBe(true);
    expect(
      (
        await agent
          .patch("/api/knowledge/auto-index")
          .send({ brandId: brand.body.id, enabled: false })
          .expect(200)
      ).body.enabled,
    ).toBe(false);
    expect(embedKnowledgeBatch).not.toHaveBeenCalled();
  });
});
