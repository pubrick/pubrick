import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { embedKnowledgeBatch } from "@pubrick/ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@pubrick/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@pubrick/ai")>();
  return { ...actual, embedKnowledgeBatch: vi.fn() };
});

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("automatic knowledge indexing database contract", () => {
  let db: Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["db"];
  let pool: Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["pool"];
  let workerPool: typeof import("../db").pool;
  let schema: typeof import("@pubrick/db").schema;
  let service: import("./knowledge-auto-index.service").KnowledgeAutoIndexService;
  let orgId: string;
  let brandId: string;
  let noteId: string;
  let pausedNoteId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.APP_ENCRYPTION_KEY = "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const dbModule = await import("@pubrick/db");
    await dbModule.runMigrations(url as string);
    schema = dbModule.schema;
    ({ db, pool } = dbModule.createDb(url as string));
    const { KnowledgeAutoIndexRepository } = await import("./knowledge-auto-index.repository");
    const { KnowledgeAutoIndexService } = await import("./knowledge-auto-index.service");
    ({ pool: workerPool } = await import("../db"));
    service = new KnowledgeAutoIndexService(new KnowledgeAutoIndexRepository());
    orgId = randomUUID();
    await db.insert(schema.organization).values({ id: orgId, name: "Index test", slug: orgId });
    const [brand] = await db
      .insert(schema.brands)
      .values({ orgId, name: "Brand" })
      .returning({ id: schema.brands.id });
    assert(brand);
    brandId = brand.id;
    const [note] = await db
      .insert(schema.knowledgeEntries)
      .values({ orgId, brandId, title: "Old", content: "Old content", category: "product_info" })
      .returning({ id: schema.knowledgeEntries.id });
    assert(note);
    noteId = note.id;
    const [pausedNote] = await db
      .insert(schema.knowledgeEntries)
      .values({
        orgId,
        brandId,
        title: "Pause",
        content: "Pause content",
        category: "product_info",
      })
      .returning({ id: schema.knowledgeEntries.id });
    assert(pausedNote);
    pausedNoteId = pausedNote.id;
  }, 30_000);

  afterAll(async () => {
    if (db && orgId) {
      const { eq } = await import("drizzle-orm");
      await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    }
    await pool?.end();
    await workerPool?.end();
  });

  it("requires opt-in and a key, shares the manual lock, and rejects edited or paused notes", async () => {
    const { eq } = await import("drizzle-orm");
    const now = new Date("2026-09-24T10:00:00Z");
    await service.scan(now);
    expect(embedKnowledgeBatch).not.toHaveBeenCalled();
    await db.insert(schema.knowledgeAutoIndex).values({ orgId, brandId, enabled: true });
    await service.scan(now);
    expect(embedKnowledgeBatch).not.toHaveBeenCalled();
    const configBeforeKey = await db
      .select()
      .from(schema.knowledgeAutoIndex)
      .where(eq(schema.knowledgeAutoIndex.brandId, brandId));
    assert(configBeforeKey[0]);
    expect(configBeforeKey[0].lastAttemptAt).toBeNull();
    const { encryptJson } = await import("@pubrick/shared");
    await db.insert(schema.aiCredentials).values({
      orgId,
      provider: "google",
      credentialsEncrypted: encryptJson(
        { apiKey: "fake-provider-key" },
        process.env.APP_ENCRYPTION_KEY as string,
      ),
    });

    const client = await pool.connect();
    const key = `knowledge:${orgId}:${brandId}`;
    await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [key]);
    try {
      await service.scan(now);
      expect(embedKnowledgeBatch).not.toHaveBeenCalled();
    } finally {
      await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]);
      client.release();
    }

    let resolveEmbedding!: (value: Awaited<ReturnType<typeof embedKnowledgeBatch>>) => void;
    vi.mocked(embedKnowledgeBatch).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveEmbedding = resolve;
        }),
    );
    const pending = service.scan(now);
    for (let attempt = 0; attempt < 100 && !resolveEmbedding; attempt++)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(resolveEmbedding).toBeDefined();
    await db
      .update(schema.knowledgeEntries)
      .set({ content: "Edited" })
      .where(eq(schema.knowledgeEntries.id, noteId));
    await db
      .update(schema.knowledgeEntries)
      .set({ isActive: false })
      .where(eq(schema.knowledgeEntries.id, pausedNoteId));
    resolveEmbedding({
      embeddings: [Array(768).fill(0.2), Array(768).fill(0.3)],
      tokens: 0,
      tokensKnown: false,
    });
    await pending;
    const [note] = await db
      .select({ embedding: schema.knowledgeEntries.embedding })
      .from(schema.knowledgeEntries)
      .where(eq(schema.knowledgeEntries.id, noteId));
    assert(note);
    expect(note.embedding).toBeNull();
    const [pausedNoteAfter] = await db
      .select({ embedding: schema.knowledgeEntries.embedding })
      .from(schema.knowledgeEntries)
      .where(eq(schema.knowledgeEntries.id, pausedNoteId));
    assert(pausedNoteAfter);
    expect(pausedNoteAfter.embedding).toBeNull();
    expect(
      (await db.select().from(schema.usageLedger).where(eq(schema.usageLedger.orgId, orgId))).map(
        (row) => row.step,
      ),
    ).toEqual(["knowledge_batch_index"]);
    const [config] = await db
      .select()
      .from(schema.knowledgeAutoIndex)
      .where(eq(schema.knowledgeAutoIndex.brandId, brandId));
    assert(config);
    expect(config.lastAttemptAt).toEqual(now);
    await db
      .update(schema.knowledgeEntries)
      .set({ isActive: true })
      .where(eq(schema.knowledgeEntries.id, pausedNoteId));
    await service.scan(now);
    expect(embedKnowledgeBatch).toHaveBeenCalledTimes(1);
  }, 30_000);
});
