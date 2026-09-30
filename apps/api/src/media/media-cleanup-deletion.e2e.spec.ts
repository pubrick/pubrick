import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type BillingTransaction, createDb, schema } from "@pubrick/db";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BrandsRepository } from "../brands/brands.repository";
import { HostedAdmissionService } from "../hosted-admission/hosted-admission.service";
import type { MediaRepository } from "./media.repository";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("native deletion cleanup boundaries", () => {
  let connection: ReturnType<typeof createDb>;
  let media: MediaRepository;
  let brands: BrandsRepository;
  let mediaDir: string;
  const orgIds: string[] = [];
  const userIds: string[] = [];
  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 17).toString("base64");
    mediaDir = await mkdtemp(path.join(tmpdir(), "pubrick-delete-cleanup-"));
    process.env.MEDIA_STORAGE_DIR = mediaDir;
    connection = createDb(url as string);
    const m = await import("./media.repository");
    const b = await import("../brands/brands.repository");
    media = new m.MediaRepository();
    brands = new b.BrandsRepository({} as ConstructorParameters<typeof b.BrandsRepository>[0]);
  });
  afterAll(async () => {
    if (!connection) return;
    for (const orgId of orgIds) {
      await connection.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
      await connection.db
        .delete(schema.mediaCleanupWork)
        .where(eq(schema.mediaCleanupWork.orgId, orgId));
    }
    for (const id of userIds) await connection.db.delete(schema.user).where(eq(schema.user.id, id));
    await connection.pool.end();
    const { pool } = await import("../db");
    await pool.end();
    await rm(mediaDir, { recursive: true, force: true });
  });
  async function fixture() {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await connection.db
      .insert(schema.organization)
      .values({ id: orgId, name: "Deletion fixture", slug: orgId });
    const [brand] = await connection.db
      .insert(schema.brands)
      .values({ orgId, name: "Fixture" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("Missing brand");
    const [asset] = await connection.db
      .insert(schema.mediaAssets)
      .values({
        orgId,
        brandId: brand.id,
        name: "Physical fixture",
        kind: "image",
        mimeType: "image/jpeg",
        byteSize: 7,
      })
      .returning({ id: schema.mediaAssets.id });
    if (!asset) throw new Error("Missing asset");
    await writeFile(path.join(mediaDir, `${asset.id}.jpg`), "fixture");
    return { orgId, brandId: brand.id, assetId: asset.id };
  }
  async function proofs(orgId: string) {
    return connection.db
      .select()
      .from(schema.mediaCleanupWork)
      .where(eq(schema.mediaCleanupWork.orgId, orgId));
  }
  it("single asset deletion commits proof and metadata removal without unlinking before worker", async () => {
    const f = await fixture();
    await media.delete(f.orgId, f.assetId);
    expect(await proofs(f.orgId)).toEqual([
      expect.objectContaining({ assetId: f.assetId, kind: "image", state: "pending" }),
    ]);
    expect(await readFile(path.join(mediaDir, `${f.assetId}.jpg`), "utf8")).toBe("fixture");
    expect(
      await connection.db
        .select()
        .from(schema.mediaAssets)
        .where(eq(schema.mediaAssets.id, f.assetId)),
    ).toHaveLength(0);
  });
  it("brand cascade commits owned proofs while leaving a different tenant untouched", async () => {
    const f = await fixture();
    const other = await fixture();
    await brands.delete(f.orgId, f.brandId);
    expect(await proofs(f.orgId)).toEqual([
      expect.objectContaining({ assetId: f.assetId, state: "pending" }),
    ]);
    expect(await proofs(other.orgId)).toHaveLength(0);
    expect(
      await connection.db
        .select()
        .from(schema.mediaAssets)
        .where(eq(schema.mediaAssets.id, other.assetId)),
    ).toHaveLength(1);
  });
  it("attachment refusal preserves metadata, file and absence of cleanup obligations", async () => {
    const f = await fixture();
    await connection.db
      .insert(schema.contentItems)
      .values({
        orgId: f.orgId,
        brandId: f.brandId,
        title: "Attached",
        body: "Fixture draft",
        coverMediaId: f.assetId,
      });
    await expect(media.delete(f.orgId, f.assetId)).rejects.toMatchObject({ status: 409 });
    expect(await proofs(f.orgId)).toHaveLength(0);
    expect(await readFile(path.join(mediaDir, `${f.assetId}.jpg`), "utf8")).toBe("fixture");
  });
  it("database cascade failure rolls back the staged proof and keeps files", async () => {
    const f = await fixture();
    // Native temporary constraint failure AFTER staging, rather than mocking transaction rollback.
    const client = await connection.pool.connect();
    try {
      await client.query(
        "create function reject_cleanup_brand_delete() returns trigger language plpgsql as $$ begin raise exception 'fixture deletion refusal'; end $$",
      );
      await client.query(
        "create trigger reject_cleanup_brand_delete before delete on brands for each row execute function reject_cleanup_brand_delete()",
      );
      await expect(brands.delete(f.orgId, f.brandId)).rejects.toThrow();
      expect(await proofs(f.orgId)).toHaveLength(0);
      expect(
        await connection.db
          .select()
          .from(schema.mediaAssets)
          .where(eq(schema.mediaAssets.id, f.assetId)),
      ).toHaveLength(1);
      expect(await readFile(path.join(mediaDir, `${f.assetId}.jpg`), "utf8")).toBe("fixture");
    } finally {
      await client.query("drop trigger if exists reject_cleanup_brand_delete on brands");
      await client.query("drop function if exists reject_cleanup_brand_delete()");
      client.release();
    }
  });
  it("actual hosted module deletion port stages media in the organization deletion transaction", async () => {
    const f = await fixture();
    const userId = randomUUID();
    const sessionId = randomUUID();
    userIds.push(userId);
    await connection.db
      .insert(schema.user)
      .values({ id: userId, name: "Owner", email: `${userId}@example.test`, emailVerified: true });
    await connection.db.insert(schema.session).values({
      id: sessionId,
      userId,
      token: randomUUID(),
      expiresAt: new Date(Date.now() + 3600000),
      activeOrganizationId: f.orgId,
    });
    await connection.db
      .insert(schema.member)
      .values({ id: randomUUID(), organizationId: f.orgId, userId, role: "owner" });
    const { HostedAdmissionModule } = await import("../hosted-admission/hosted-admission.module");
    const module = HostedAdmissionModule.forRoot({
      enabled: true,
      driver: "fixture",
      identity: { provider: "fixture", environment: "sandbox", accountId: "cleanup" },
      publicOrigin: "http://localhost:3000",
      plans: [],
      fixturePrices: [],
      accountPolicy: { maxOwnedWorkspaces: 5, maxCreatesPerDay: 5 },
      trial: { enabled: false },
      sdkTimeoutMs: 1000,
      tickBudgetMs: 1000,
      sweepIntervalMs: 10000,
    });
    const provider = module.providers?.find(
      (entry) =>
        typeof entry === "object" && "provide" in entry && entry.provide === HostedAdmissionService,
    );
    if (!provider || typeof provider !== "object" || !("useFactory" in provider))
      throw new Error("Missing composition factory");
    const tombstone = vi.fn(async (_orgId: string, tx: BillingTransaction) => {
      await tx.execute(sql`select 1`);
    });
    const service: HostedAdmissionService = await provider.useFactory(
      { tombstoneInTx: tombstone },
      {},
    );
    await service.delete(f.orgId, { userId, sessionId });
    expect(tombstone).toHaveBeenCalledTimes(1);
    expect(
      await connection.db
        .select()
        .from(schema.organization)
        .where(eq(schema.organization.id, f.orgId)),
    ).toHaveLength(0);
    expect(await proofs(f.orgId)).toEqual([
      expect.objectContaining({ assetId: f.assetId, state: "pending" }),
    ]);
  });
});
