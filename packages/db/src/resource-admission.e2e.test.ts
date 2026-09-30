import { randomUUID } from "node:crypto";
import { RUN_ADMISSION_LOCK_NAMESPACE } from "@pubrick/shared";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BillingTransaction } from "./billing-entitlement.js";
import { createDb } from "./client.js";
import { stageMediaCleanup } from "./media-cleanup.js";
import { runMigrations } from "./migrate.js";
import {
  withTenantResourceAdmission,
  withTenantResourceAdmissionWithHeldLocks,
} from "./resource-admission.js";
import * as schema from "./schema/index.js";

const url = process.env.TEST_DATABASE_URL;
const identity = {
  provider: "stripe" as const,
  environment: "sandbox",
  accountId: "acct_resource_operator",
};
const hosted = { mode: "hosted", identity } as const;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe.skipIf(!url)("native tenant resource quota admission", () => {
  let connection: ReturnType<typeof createDb>;
  const orgIds: string[] = [];
  const planIds: string[] = [];
  beforeAll(async () => {
    await runMigrations(url as string);
    connection = createDb(url as string);
  }, 60_000);
  afterAll(async () => {
    if (!connection) return;
    for (const orgId of orgIds) {
      await connection.db
        .delete(schema.mediaCleanupWork)
        .where(eq(schema.mediaCleanupWork.orgId, orgId));
      await connection.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
      await connection.db
        .delete(schema.billingSubscriptions)
        .where(eq(schema.billingSubscriptions.orgId, orgId));
    }
    for (const id of planIds)
      await connection.db
        .delete(schema.billingPlanVersions)
        .where(eq(schema.billingPlanVersions.id, id));
    await connection.pool.end();
  });
  async function fixture(limits: Partial<schema.BillingLimits> = {}) {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await connection.db
      .insert(schema.organization)
      .values({ id: orgId, name: "Resource fixture", slug: orgId });
    const planId = randomUUID();
    planIds.push(planId);
    const priceId = `price_${planId}`;
    await connection.db.insert(schema.billingPlanVersions).values({
      id: planId,
      ...identity,
      planId: "resource-fixture",
      version: planId,
      priceId,
      price: {
        priceId,
        productId: `product_${planId}`,
        currency: "usd",
        unitAmount: 100,
        interval: "month",
        intervalCount: 1,
      },
      limits: { seats: 2, brands: 2, channels: 1, mediaBytes: 100, concurrentJobs: 1, ...limits },
    });
    const subscriptionId = `sub_${orgId}`;
    const periodEnd = new Date(Date.now() + 86400000);
    await connection.db.insert(schema.billingSubscriptions).values({
      orgId,
      ...identity,
      customerId: `cus_${orgId}`,
      subscriptionId,
      status: "active",
      priceId,
      planVersionId: planId,
      periodStart: new Date(Date.now() - 3600000),
      periodEnd,
      cancelAtPeriodEnd: false,
    });
    await connection.db.insert(schema.organizationBillingState).values({
      orgId,
      subscriptionId,
      planVersionId: planId,
      access: true,
      accessUntil: periodEnd,
    });
    const [brand] = await connection.db
      .insert(schema.brands)
      .values({ orgId, name: "Existing brand" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("Missing fixture brand");
    return { orgId, brandId: brand.id };
  }
  async function media(
    tx: BillingTransaction,
    orgId: string,
    brandId: string,
    byteSize: number,
    name = "Uploaded normalized fixture",
    kind: "image" | "video" = "image",
  ) {
    // This database-only gate checks actual metadata accounting. Encoder/file
    // preparation and cleanup are separate integration contracts, not simulated here.
    return tx
      .insert(schema.mediaAssets)
      .values({
        orgId,
        brandId,
        name,
        byteSize,
        kind,
        mimeType: kind === "image" ? "image/jpeg" : "video/mp4",
        width: kind === "image" ? 10 : null,
        height: kind === "image" ? 10 : null,
      })
      .returning({ id: schema.mediaAssets.id });
  }
  async function rows(orgId: string, resource: "brands" | "channels" | "mediaBytes") {
    if (resource === "brands")
      return connection.db
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(eq(schema.brands.orgId, orgId));
    if (resource === "channels")
      return connection.db
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(eq(schema.channels.orgId, orgId));
    return connection.db
      .select({ id: schema.mediaAssets.id })
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.orgId, orgId));
  }
  async function blockedAdmission() {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const result = await connection.pool.query(
        "select count(*)::int as n from pg_locks where locktype='advisory' and classid=$1 and not granted",
        [RUN_ADMISSION_LOCK_NAMESPACE],
      );
      if (result.rows[0].n > 0) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error("No shared admission waiter observed");
  }
  it("admits one concurrent brand at the last available slot", async () => {
    const { orgId } = await fixture();
    const results = await Promise.allSettled(
      [1, 2].map((i) =>
        withTenantResourceAdmission(
          orgId,
          connection.db,
          hosted,
          { resource: "brands", additional: 1 },
          async (tx) => tx.insert(schema.brands).values({ orgId, name: `Candidate ${i}` }),
        ),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const denied = results.find((result) => result.status === "rejected");
    expect(denied?.status === "rejected" ? denied.reason.message : null).toBe("resource_limit");
    expect(await rows(orgId, "brands")).toHaveLength(2);
  });
  it("admits one concurrent channel at the last available slot", async () => {
    const { orgId, brandId } = await fixture();
    const results = await Promise.allSettled(
      [1, 2].map((i) =>
        withTenantResourceAdmission(
          orgId,
          connection.db,
          hosted,
          { resource: "channels", additional: 1 },
          async (tx) =>
            tx.insert(schema.channels).values({
              orgId,
              brandId,
              name: `Candidate ${i}`,
              platform: "telegram",
              credentialsEncrypted: "opaque-test-only",
            }),
        ),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await rows(orgId, "channels")).toHaveLength(1);
  });
  it("counts upload, generated and crop bytes together and admits one concurrent final normalized file", async () => {
    const { orgId, brandId } = await fixture();
    await connection.db.transaction(async (tx) => {
      await media(tx, orgId, brandId, 40, "Uploaded normalized fixture");
      await media(tx, orgId, brandId, 30, "Generated normalized fixture");
      await media(tx, orgId, brandId, 20, "Cropped video fixture", "video");
    });
    const normalized = Buffer.alloc(10);
    const results = await Promise.allSettled(
      [1, 2].map((i) =>
        withTenantResourceAdmission(
          orgId,
          connection.db,
          hosted,
          { resource: "mediaBytes", additional: normalized.length },
          async (tx) => media(tx, orgId, brandId, normalized.length, `Candidate ${i}`),
        ),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const total = await connection.db
      .select({ bytes: sql<string>`sum(${schema.mediaAssets.byteSize})::text` })
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.orgId, orgId));
    expect(total[0]?.bytes).toBe("100");
    expect(await rows(orgId, "mediaBytes")).toHaveLength(4);
  });
  it("retains deleted media bytes until physical cleanup is acknowledged", async () => {
    const { orgId, brandId } = await fixture();
    const [asset] = await connection.db.transaction((tx) => media(tx, orgId, brandId, 100));
    if (!asset) throw new Error("Missing asset");
    await connection.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${RUN_ADMISSION_LOCK_NAMESPACE},hashtext(${orgId}))`,
      );
      await stageMediaCleanup(orgId, tx, { assetIds: [asset.id] });
      await tx.delete(schema.mediaAssets).where(eq(schema.mediaAssets.id, asset.id));
    });
    const insert = vi.fn((tx: BillingTransaction) => media(tx, orgId, brandId, 1));
    await expect(
      withTenantResourceAdmission(
        orgId,
        connection.db,
        hosted,
        { resource: "mediaBytes", additional: 1 },
        insert,
      ),
    ).rejects.toMatchObject({ code: "resource_limit" });
    expect(insert).not.toHaveBeenCalled();
    // Cleanup remains stopped/unavailable even after retries become operator-owned.
    await connection.db
      .update(schema.mediaCleanupWork)
      .set({ state: "operator_action", lastError: "storage_unavailable" })
      .where(eq(schema.mediaCleanupWork.assetId, asset.id));
    await expect(
      withTenantResourceAdmission(
        orgId,
        connection.db,
        hosted,
        { resource: "mediaBytes", additional: 1 },
        insert,
      ),
    ).rejects.toMatchObject({ code: "resource_limit" });
    // The worker's successful unlink/ENOENT acknowledgement is the only release boundary.
    await connection.db
      .update(schema.mediaCleanupWork)
      .set({ state: "completed", completedAt: new Date() })
      .where(eq(schema.mediaCleanupWork.assetId, asset.id));
    await withTenantResourceAdmission(
      orgId,
      connection.db,
      hosted,
      { resource: "mediaBytes", additional: 1 },
      insert,
    );
    expect(insert).toHaveBeenCalledOnce();
  });
  it("scopes real brands, channels and media aggregates to the target tenant", async () => {
    const target = await fixture();
    const other = await fixture();
    await connection.db.insert(schema.brands).values([
      { orgId: other.orgId, name: "Foreign extra one" },
      { orgId: other.orgId, name: "Foreign extra two" },
    ]);
    await connection.db.insert(schema.channels).values([
      {
        orgId: other.orgId,
        brandId: other.brandId,
        name: "Foreign one",
        platform: "telegram",
        credentialsEncrypted: "opaque-test-only",
      },
      {
        orgId: other.orgId,
        brandId: other.brandId,
        name: "Foreign two",
        platform: "telegram",
        credentialsEncrypted: "opaque-test-only",
      },
    ]);
    await connection.db.transaction((tx) => media(tx, other.orgId, other.brandId, 1000));
    await withTenantResourceAdmission(
      target.orgId,
      connection.db,
      hosted,
      { resource: "brands", additional: 1 },
      async (tx) => tx.insert(schema.brands).values({ orgId: target.orgId, name: "Admitted" }),
    );
    await withTenantResourceAdmission(
      target.orgId,
      connection.db,
      hosted,
      { resource: "channels", additional: 1 },
      async (tx) =>
        tx.insert(schema.channels).values({
          orgId: target.orgId,
          brandId: target.brandId,
          name: "Admitted",
          platform: "telegram",
          credentialsEncrypted: "opaque-test-only",
        }),
    );
    await withTenantResourceAdmission(
      target.orgId,
      connection.db,
      hosted,
      { resource: "mediaBytes", additional: 10 },
      (tx) => media(tx, target.orgId, target.brandId, 10),
    );
    expect(await rows(target.orgId, "brands")).toHaveLength(2);
    expect(await rows(target.orgId, "channels")).toHaveLength(1);
    expect(await rows(target.orgId, "mediaBytes")).toHaveLength(1);
  });
  it("refuses expired projection and a replaced operator identity without invoking insertion", async () => {
    const { orgId } = await fixture();
    const insert = vi.fn();
    await connection.db
      .update(schema.organizationBillingState)
      .set({ accessUntil: new Date(Date.now() - 1000) })
      .where(eq(schema.organizationBillingState.orgId, orgId));
    await expect(
      withTenantResourceAdmission(
        orgId,
        connection.db,
        hosted,
        { resource: "brands", additional: 1 },
        insert,
      ),
    ).rejects.toThrow("subscription_required");
    await connection.db
      .update(schema.organizationBillingState)
      .set({ accessUntil: new Date(Date.now() + 3600000) })
      .where(eq(schema.organizationBillingState.orgId, orgId));
    await expect(
      withTenantResourceAdmission(
        orgId,
        connection.db,
        { mode: "hosted", identity: { ...identity, accountId: "acct_replaced_operator" } },
        { resource: "brands", additional: 1 },
        insert,
      ),
    ).rejects.toThrow("billing_identity_mismatch");
    expect(insert).not.toHaveBeenCalled();
    expect(await rows(orgId, "brands")).toHaveLength(1);
  });
  it("rolls back an insertion callback that writes a different row or normalized byte increase", async () => {
    const { orgId, brandId } = await fixture({ brands: 10 });
    await expect(
      withTenantResourceAdmission(
        orgId,
        connection.db,
        hosted,
        { resource: "brands", additional: 1 },
        async (tx) =>
          tx.insert(schema.brands).values([
            { orgId, name: "Extra one" },
            { orgId, name: "Extra two" },
          ]),
      ),
    ).rejects.toThrow("growth_mismatch");
    await expect(
      withTenantResourceAdmission(
        orgId,
        connection.db,
        hosted,
        { resource: "mediaBytes", additional: 10 },
        (tx) => media(tx, orgId, brandId, 9),
      ),
    ).rejects.toThrow("growth_mismatch");
    expect(await rows(orgId, "brands")).toHaveLength(1);
    expect(await rows(orgId, "mediaBytes")).toHaveLength(0);
  });
  it("refuses zero, fractional and unsafe normalized byte additions before any insertion", async () => {
    const { orgId } = await fixture();
    const insert = vi.fn();
    for (const additional of [0, -1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1])
      await expect(
        withTenantResourceAdmission(
          orgId,
          connection.db,
          hosted,
          { resource: "mediaBytes", additional },
          insert,
        ),
      ).rejects.toThrow("invalid_growth");
    expect(insert).not.toHaveBeenCalled();
    expect(await rows(orgId, "mediaBytes")).toHaveLength(0);
  });
  it("uses the held-lock variant within an existing tenant-first transaction", async () => {
    const { orgId } = await fixture();
    await connection.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${RUN_ADMISSION_LOCK_NAMESPACE},hashtext(${orgId}))`,
      );
      await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, orgId))
        .for("key share");
      await withTenantResourceAdmissionWithHeldLocks(
        orgId,
        tx,
        hosted,
        { resource: "brands", additional: 1 },
        async (same) => {
          expect(same).toBe(tx);
          await same.insert(schema.brands).values({ orgId, name: "Held admission" });
        },
      );
    });
    expect(await rows(orgId, "brands")).toHaveLength(2);
  });
  it("serializes an admitted insert before concurrent organization deletion without FK phantoms", async () => {
    const { orgId } = await fixture();
    const admitted = deferred();
    const commit = deferred();
    const insertion = withTenantResourceAdmission(
      orgId,
      connection.db,
      hosted,
      { resource: "brands", additional: 1 },
      async (tx) => {
        admitted.resolve();
        await commit.promise;
        await tx.insert(schema.brands).values({ orgId, name: "Racing insert" });
      },
    );
    const insertionOutcome = insertion.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    await admitted.promise;
    const deletion = connection.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${RUN_ADMISSION_LOCK_NAMESPACE},hashtext(${orgId}))`,
      );
      await tx.delete(schema.organization).where(eq(schema.organization.id, orgId));
    });
    const deletionOutcome = deletion.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    try {
      await blockedAdmission();
    } finally {
      commit.resolve();
    }
    expect(await insertionOutcome).toEqual({ ok: true });
    expect(await deletionOutcome).toEqual({ ok: true });
    expect(await rows(orgId, "brands")).toHaveLength(0);
  });
  it("refuses admission after a concurrently committed organization deletion", async () => {
    const { orgId } = await fixture();
    const removed = deferred();
    const commit = deferred();
    const deletion = connection.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(${RUN_ADMISSION_LOCK_NAMESPACE},hashtext(${orgId}))`,
      );
      await tx.delete(schema.organization).where(eq(schema.organization.id, orgId));
      removed.resolve();
      await commit.promise;
    });
    const deletionOutcome = deletion.then(
      () => ({ ok: true }),
      (error) => ({ ok: false, error }),
    );
    await removed.promise;
    const insert = vi.fn();
    const insertion = withTenantResourceAdmission(
      orgId,
      connection.db,
      hosted,
      { resource: "brands", additional: 1 },
      insert,
    );
    const insertionOutcome = insertion.then(
      () => ({ ok: true, message: "" }),
      (error) => ({ ok: false, message: error.message }),
    );
    try {
      await blockedAdmission();
    } finally {
      commit.resolve();
    }
    expect(await deletionOutcome).toEqual({ ok: true });
    expect(await insertionOutcome).toEqual({ ok: false, message: "target_unavailable" });
    expect(insert).not.toHaveBeenCalled();
    expect(await rows(orgId, "brands")).toHaveLength(0);
  });
});
