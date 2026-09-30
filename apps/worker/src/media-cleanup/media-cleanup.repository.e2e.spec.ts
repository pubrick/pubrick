import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, schema, stageMediaCleanup } from "@pubrick/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MediaCleanupRepository } from "./media-cleanup.repository";
import type { MediaCleanupService } from "./media-cleanup.service";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("native durable media cleanup", () => {
  let connection: ReturnType<typeof createDb>;
  let repository: MediaCleanupRepository;
  let service: MediaCleanupService;
  let mediaDir: string;
  const orgIds: string[] = [];
  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    mediaDir = await mkdtemp(path.join(tmpdir(), "pubrick-media-cleanup-native-"));
    process.env.MEDIA_STORAGE_DIR = mediaDir;
    connection = createDb(url as string);
    const r = await import("./media-cleanup.repository");
    const s = await import("./media-cleanup.service");
    repository = new r.MediaCleanupRepository();
    service = new s.MediaCleanupService(repository);
  });
  afterAll(async () => {
    if (!connection) return;
    for (const orgId of orgIds) {
      await connection.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
      await connection.db
        .delete(schema.mediaCleanupWork)
        .where(eq(schema.mediaCleanupWork.orgId, orgId));
    }
    await connection.pool.end();
    const { pool } = await import("../db");
    await pool.end();
    await rm(mediaDir, { recursive: true, force: true });
  });
  async function fixture(kind: "image" | "video" = "image", count = 1) {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await connection.db
      .insert(schema.organization)
      .values({ id: orgId, name: "Cleanup", slug: orgId });
    const [brand] = await connection.db
      .insert(schema.brands)
      .values({ orgId, name: "Cleanup" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("Missing brand fixture");
    const assets = await connection.db
      .insert(schema.mediaAssets)
      .values(
        Array.from({ length: count }, () => ({
          orgId,
          brandId: brand.id,
          name: "Cleanup asset",
          kind,
          byteSize: 10,
          mimeType: kind === "image" ? "image/jpeg" : "video/mp4",
          width: kind === "image" ? 1 : null,
          height: kind === "image" ? 1 : null,
        })),
      )
      .returning({ id: schema.mediaAssets.id });
    return { orgId, brandId: brand.id, ids: assets.map((asset) => asset.id) };
  }
  async function remove(f: Awaited<ReturnType<typeof fixture>>) {
    await connection.db.transaction(async (tx) => {
      await stageMediaCleanup(f.orgId, tx);
      await tx.delete(schema.organization).where(eq(schema.organization.id, f.orgId));
    });
  }
  async function row(id: string) {
    const [value] = await connection.db
      .select()
      .from(schema.mediaCleanupWork)
      .where(eq(schema.mediaCleanupWork.assetId, id));
    if (!value) throw new Error("Missing cleanup proof");
    return value;
  }
  it("rolls staging back with a refused domain deletion", async () => {
    const f = await fixture();
    await expect(
      connection.db.transaction(async (tx) => {
        await stageMediaCleanup(f.orgId, tx);
        throw new Error("deletion refused");
      }),
    ).rejects.toThrow("deletion refused");
    expect(
      await connection.db
        .select()
        .from(schema.mediaCleanupWork)
        .where(eq(schema.mediaCleanupWork.orgId, f.orgId)),
    ).toHaveLength(0);
    expect(
      await connection.db
        .select()
        .from(schema.mediaAssets)
        .where(eq(schema.mediaAssets.orgId, f.orgId)),
    ).toHaveLength(1);
    await connection.db.delete(schema.organization).where(eq(schema.organization.id, f.orgId));
  });
  it("survives organization cascade and cleans image/video files through the real worker", async () => {
    for (const kind of ["image", "video"] as const) {
      const f = await fixture(kind);
      const id = f.ids[0];
      if (!id) throw new Error("Missing asset");
      const target = path.join(mediaDir, `${id}.${kind === "image" ? "jpg" : "mp4"}`);
      await writeFile(target, "media");
      await remove(f);
      expect((await row(id)).state).toBe("pending");
      await service.tick();
      expect((await row(id)).state).toBe("completed");
      await expect(readFile(target)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
  it("scopes explicit and brand staging to the owning organization", async () => {
    const own = await fixture();
    const other = await fixture();
    await expect(
      connection.db.transaction((tx) => stageMediaCleanup(own.orgId, tx, { brandId: "" })),
    ).rejects.toThrow("media_cleanup_invalid_scope");
    await connection.db.transaction(async (tx) => {
      await stageMediaCleanup(own.orgId, tx, { assetIds: other.ids });
      await stageMediaCleanup(own.orgId, tx, { brandId: other.brandId });
    });
    expect(
      await connection.db
        .select()
        .from(schema.mediaCleanupWork)
        .where(eq(schema.mediaCleanupWork.orgId, own.orgId)),
    ).toHaveLength(0);
    await connection.db.delete(schema.organization).where(eq(schema.organization.id, own.orgId));
    await connection.db.delete(schema.organization).where(eq(schema.organization.id, other.orgId));
  });
  it("claims bounded disjoint batches across concurrent replicas", async () => {
    const f = await fixture("image", 30);
    await remove(f);
    const [a, b] = await Promise.all([repository.claim(), repository.claim()]);
    expect(a.length).toBeLessThanOrEqual(25);
    expect(b.length).toBeLessThanOrEqual(25);
    expect(a.length + b.length).toBe(30);
    expect(new Set([...a, ...b].map((item) => item.assetId)).size).toBe(30);
    for (const item of [...a, ...b]) await repository.complete(item);
  });
  it("fences acknowledgements after lease expiry and records retry backoff durably", async () => {
    const f = await fixture();
    await remove(f);
    const now = new Date();
    const [old] = await repository.claim(now);
    if (!old) throw new Error("Missing old lease");
    const [fresh] = await repository.claim(new Date(now.getTime() + 60_001));
    if (!fresh) throw new Error("Missing new lease");
    expect(fresh.leaseToken).not.toBe(old.leaseToken);
    expect(fresh.attempts).toBe(2);
    expect(await repository.complete(old)).toBe(false);
    expect(await repository.fail(old, "permission")).toBe(false);
    const failedAt = new Date(now.getTime() + 60_002);
    await repository.fail(fresh, "permission", failedAt);
    expect((await row(fresh.assetId)).nextAttemptAt.getTime()).toBe(failedAt.getTime() + 20_000);
    expect(await repository.claim(failedAt)).toHaveLength(0);
    const [next] = await repository.claim(new Date(failedAt.getTime() + 20_001));
    if (!next) throw new Error("Missing retry lease");
    await repository.complete(next);
  });
  it("refuses live restored assets without touching their files", async () => {
    const f = await fixture();
    const id = f.ids[0];
    if (!id) throw new Error("Missing asset");
    const target = path.join(mediaDir, `${id}.jpg`);
    await writeFile(target, "restored media");
    await connection.db.transaction((tx) => stageMediaCleanup(f.orgId, tx));
    expect(await repository.claim()).toHaveLength(0);
    expect(await readFile(target, "utf8")).toBe("restored media");
    expect(await row(id)).toMatchObject({ state: "operator_action", lastError: "asset_exists" });
    await remove(f);
    const [rearmed] = await repository.claim();
    if (!rearmed) throw new Error("Missing rearmed lease");
    expect(rearmed.attempts).toBe(1);
    await repository.complete(rearmed);
  });
  it("rearms a completed same-owned restored UUID and refuses foreign ownership proof", async () => {
    const f = await fixture();
    const id = f.ids[0];
    if (!id) throw new Error("Missing asset");
    await connection.db.insert(schema.mediaCleanupWork).values({
      assetId: id,
      orgId: f.orgId,
      kind: "image",
      state: "completed",
      completedAt: new Date(),
      attempts: 8,
    });
    await connection.db.transaction((tx) => stageMediaCleanup(f.orgId, tx, { assetIds: [id] }));
    expect(await row(id)).toMatchObject({
      state: "pending",
      completedAt: null,
      attempts: 0,
      leaseToken: null,
    });
    await connection.db
      .update(schema.mediaCleanupWork)
      .set({ orgId: "foreign-proof" })
      .where(eq(schema.mediaCleanupWork.assetId, id));
    await expect(connection.db.transaction((tx) => stageMediaCleanup(f.orgId, tx))).rejects.toThrow(
      "media_cleanup_ownership_conflict",
    );
    await connection.db
      .update(schema.mediaCleanupWork)
      .set({ orgId: f.orgId })
      .where(eq(schema.mediaCleanupWork.assetId, id));
    await remove(f);
    await service.tick();
  });
  it("bounds crash-only retries and explicit disk failures at eight claims", async () => {
    const f = await fixture("image", 2);
    await remove(f);
    let now = new Date();
    let current = await repository.claim(now);
    for (let attempt = 1; attempt <= 8; attempt++) {
      expect(current).toHaveLength(2);
      expect(current.every((item) => item.attempts === attempt)).toBe(true);
      if (attempt === 8) {
        const first = current[0];
        if (!first) throw new Error("Missing claim");
        await repository.fail(first, "permission", now);
      }
      now = new Date(now.getTime() + 60_001);
      current = await repository.claim(now);
    }
    expect(current).toHaveLength(0);
    const [firstId, secondId] = f.ids;
    if (!firstId || !secondId) throw new Error("Missing exhausted fixture IDs");
    expect((await row(firstId)).state).toBe("operator_action");
    expect((await row(secondId)).state).toBe("operator_action");
  });
  it("prunes only completed proofs older than seven days in bounded batches", async () => {
    const f = await fixture("image", 30);
    await remove(f);
    await connection.db
      .update(schema.mediaCleanupWork)
      .set({ state: "completed", completedAt: new Date(Date.now() - 8 * 86400_000) })
      .where(eq(schema.mediaCleanupWork.orgId, f.orgId));
    expect(await repository.prune()).toBe(25);
    expect(await repository.prune()).toBe(5);
  });
});
