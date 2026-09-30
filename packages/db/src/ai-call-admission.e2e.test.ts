import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { acquireHostedAiCall, releaseHostedAiCall, withHostedAiCall } from "./ai-call-admission.js";
import { createDb } from "./client.js";
import { runMigrations } from "./migrate.js";
import * as schema from "./schema/index.js";

const url = process.env.TEST_DATABASE_URL;
const identity = { provider: "stripe", environment: "sandbox", accountId: "acct_lease_operator" };
const hosted = { mode: "hosted", identity } as const;
describe.skipIf(!url)("native physical model call admission", () => {
  let connection: ReturnType<typeof createDb>;
  const orgIds: string[] = [];
  const planIds: string[] = [];
  beforeAll(async () => {
    await runMigrations(url as string);
    connection = createDb(url as string, { max: 8, connectionTimeoutMillis: 5000 });
  }, 60000);
  afterAll(async () => {
    if (!connection) return;
    for (const orgId of orgIds) {
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
    return { orgId };
  }

  async function leases(orgId: string) {
    return connection.db
      .select()
      .from(schema.hostedAiCallLeases)
      .where(eq(schema.hostedAiCallLeases.orgId, orgId));
  }
  it("concurrent classes share one paid slot and fenced release is tenant scoped", async () => {
    const { orgId } = await fixture();
    const other = await fixture();
    const result = await Promise.allSettled([
      acquireHostedAiCall(orgId, connection.db, hosted, "text"),
      acquireHostedAiCall(orgId, connection.db, hosted, "image"),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(result.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "concurrency_limit" },
    });
    const row = (await leases(orgId))[0];
    if (!row) throw new Error("Missing lease");
    await releaseHostedAiCall(other.orgId, connection.db, row.id);
    expect(await leases(orgId)).toHaveLength(1);
    await releaseHostedAiCall(orgId, connection.db, randomUUID());
    expect(await leases(orgId)).toHaveLength(1);
    await releaseHostedAiCall(orgId, connection.db, row.id);
    expect(await leases(orgId)).toHaveLength(0);
  });
  it("probe before payment has one diagnostic slot; normal calls still need subscription", async () => {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await connection.db
      .insert(schema.organization)
      .values({ id: orgId, name: "Unconfigured", slug: orgId });
    const result = await Promise.allSettled([
      acquireHostedAiCall(orgId, connection.db, hosted, "probe"),
      acquireHostedAiCall(orgId, connection.db, hosted, "probe"),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(result.find((r) => r.status === "rejected")).toMatchObject({
      reason: { code: "probe_concurrency_limit" },
    });
    await expect(acquireHostedAiCall(orgId, connection.db, hosted, "text")).rejects.toMatchObject({
      code: "subscription_required",
    });
  });
  it("diagnostic can add one call but normal includes the probe in occupancy", async () => {
    const { orgId } = await fixture();
    const normal = await acquireHostedAiCall(orgId, connection.db, hosted, "embedding");
    await acquireHostedAiCall(orgId, connection.db, hosted, "probe");
    expect(await leases(orgId)).toHaveLength(2);
    if (!normal) throw new Error("Missing lease");
    await releaseHostedAiCall(orgId, connection.db, normal.id);
    await expect(acquireHostedAiCall(orgId, connection.db, hosted, "image")).rejects.toMatchObject({
      code: "concurrency_limit",
    });
  });
  it("expired subscription and replaced operator reject without physical SDK or leases", async () => {
    const { orgId } = await fixture();
    const dispatch = vi.fn();
    await expect(
      withHostedAiCall(
        orgId,
        connection.db,
        { mode: "hosted", identity: { ...identity, accountId: "replacement" } },
        "text",
        undefined,
        dispatch,
      ),
    ).rejects.toMatchObject({ code: "billing_identity_mismatch" });
    await connection.db
      .update(schema.organizationBillingState)
      .set({ accessUntil: new Date(0) })
      .where(eq(schema.organizationBillingState.orgId, orgId));
    await expect(
      withHostedAiCall(orgId, connection.db, hosted, "embedding", undefined, dispatch),
    ).rejects.toMatchObject({ code: "subscription_required" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await leases(orgId)).toHaveLength(0);
  });
  it("committed lease visible to separate connection; no checked-out transaction during SDK", async () => {
    const { orgId } = await fixture();
    await expect(
      withHostedAiCall(orgId, connection.db, hosted, "text", undefined, async (scope) => {
        expect(scope.leaseId).toBeTruthy();
        expect(scope.signal.aborted).toBe(false);
        const rows = await connection.pool.query(
          "select id from hosted_ai_call_leases where org_id=$1",
          [orgId],
        );
        expect(rows.rowCount).toBe(1);
        const active = await connection.pool.query(
          "select count(*)::int as n from pg_stat_activity where datname=current_database() and state='idle in transaction'",
        );
        expect(active.rows[0].n).toBe(0);
        return "ok";
      }),
    ).resolves.toBe("ok");
    expect(await leases(orgId)).toHaveLength(0);
  });
  it("callback failure releases then retry acquires a new UUID fence", async () => {
    const { orgId } = await fixture();
    const ids: string[] = [];
    const sdkFailure = new Error("SDK unavailable");
    await expect(
      withHostedAiCall(orgId, connection.db, hosted, "image", undefined, async (scope) => {
        ids.push(scope.leaseId as string);
        throw sdkFailure;
      }),
    ).rejects.toBe(sdkFailure);
    await withHostedAiCall(orgId, connection.db, hosted, "image", undefined, async (scope) => {
      ids.push(scope.leaseId as string);
    });
    expect(new Set(ids).size).toBe(2);
    expect(await leases(orgId)).toHaveLength(0);
  });
  it("aborted during acquire rolls back without dispatch", async () => {
    const { orgId } = await fixture();
    const abort = new AbortController();
    const dispatch = vi.fn();
    // Real PostgreSQL advisory holder forces the signal to expire while admission waits.
    const client = await connection.pool.connect();
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock($1,hashtext($2))", [0x7a11, orgId]);
    const call = withHostedAiCall(orgId, connection.db, hosted, "text", abort.signal, dispatch);
    abort.abort();
    await client.query("commit");
    client.release();
    await expect(call).rejects.toMatchObject({ code: "aborted" });
    expect(dispatch).not.toHaveBeenCalled();
    expect(await leases(orgId)).toHaveLength(0);
  });
  it("DB clock timestamps ignore JavaScript clock skew and prune only own expired rows", async () => {
    const { orgId } = await fixture();
    const other = await fixture();
    const old = {
      kind: "embedding" as const,
      createdAt: new Date(0),
      dispatchDeadlineAt: new Date(30000),
      leaseExpiresAt: new Date(90000),
    };
    await connection.db.insert(schema.hostedAiCallLeases).values([
      { ...old, orgId },
      { ...old, orgId: other.orgId },
    ]);
    const lease = await acquireHostedAiCall(orgId, connection.db, hosted, "embedding");
    if (!lease) throw new Error("Missing lease");
    const [row] = await leases(orgId);
    if (!row) throw new Error("Missing lease");
    expect(row.dispatchDeadlineAt.getTime() - row.createdAt.getTime()).toBe(30000);
    expect(row.leaseExpiresAt.getTime() - row.dispatchDeadlineAt.getTime()).toBe(60000);
    expect(await leases(other.orgId)).toHaveLength(1);
    expect(Math.abs(row.createdAt.getTime() - Date.now())).toBeLessThan(3000);
  });
  it("expired crash lease admits recovery while live expiry refuses", async () => {
    const { orgId } = await fixture();
    const lease = await acquireHostedAiCall(orgId, connection.db, hosted, "image");
    if (!lease) throw new Error("Missing lease");
    await expect(
      acquireHostedAiCall(orgId, connection.db, hosted, "embedding"),
    ).rejects.toMatchObject({ code: "concurrency_limit" });
    await connection.db
      .update(schema.hostedAiCallLeases)
      .set({
        createdAt: new Date(0),
        dispatchDeadlineAt: new Date(120000),
        leaseExpiresAt: new Date(180000),
      })
      .where(eq(schema.hostedAiCallLeases.id, lease.id));
    const next = await acquireHostedAiCall(orgId, connection.db, hosted, "text");
    expect(next?.id).not.toBe(lease.id);
    expect(await leases(orgId)).toHaveLength(1);
  });
  it("deleted tenant refuses and cascade removes its physical leases", async () => {
    const { orgId } = await fixture();
    await acquireHostedAiCall(orgId, connection.db, hosted, "probe");
    await connection.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    expect(await leases(orgId)).toHaveLength(0);
    await expect(acquireHostedAiCall(orgId, connection.db, hosted, "probe")).rejects.toMatchObject({
      code: "organization_unavailable",
    });
  });
  it("cancellation never releases an unsettled physical callback early", async () => {
    const { orgId } = await fixture();
    const caller = new AbortController();
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: () => void;
    const settlement = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const result = withHostedAiCall(
      orgId,
      connection.db,
      hosted,
      "text",
      caller.signal,
      async (scope) => {
        started();
        await settlement;
        expect(scope.signal.aborted).toBe(true);
        return "settled";
      },
    );
    await entered;
    caller.abort();
    await expect(acquireHostedAiCall(orgId, connection.db, hosted, "image")).rejects.toMatchObject({
      code: "concurrency_limit",
    });
    expect(await leases(orgId)).toHaveLength(1);
    finish();
    await expect(result).resolves.toBe("settled");
    expect(await leases(orgId)).toHaveLength(0);
  });
  it("release outage retains TTL fence without changing successful SDK result", async () => {
    const { orgId } = await fixture();
    const report = vi.fn();
    const realTransaction = connection.db.transaction.bind(connection.db);
    const spy = vi.spyOn(connection.db, "transaction");
    spy
      .mockImplementationOnce(realTransaction)
      .mockRejectedValueOnce(new Error("secret SQL diagnostics"));
    try {
      await expect(
        withHostedAiCall(orgId, connection.db, hosted, "text", undefined, async () => "success", {
          onReleaseFailure: report,
        }),
      ).resolves.toBe("success");
      expect(report).toHaveBeenCalledWith();
      expect(await leases(orgId)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
  it("abort after commit compensates the fenced lease before any SDK dispatch", async () => {
    const { orgId } = await fixture();
    const caller = new AbortController();
    const dispatch = vi.fn();
    const realTransaction = connection.db.transaction.bind(connection.db);
    const spy = vi.spyOn(connection.db, "transaction").mockImplementationOnce(async (...args) => {
      const result = await realTransaction(...args);
      caller.abort();
      return result;
    });
    try {
      await expect(
        withHostedAiCall(orgId, connection.db, hosted, "text", caller.signal, dispatch),
      ).rejects.toMatchObject({ code: "aborted" });
      expect(dispatch).not.toHaveBeenCalled();
      expect(await leases(orgId)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });
  it("expired own-tenant pruning is capped at one thousand rows per admission", async () => {
    const { orgId } = await fixture();
    await connection.db.insert(schema.hostedAiCallLeases).values(
      Array.from({ length: 1001 }, () => ({
        orgId,
        kind: "probe" as const,
        createdAt: new Date(0),
        dispatchDeadlineAt: new Date(30000),
        leaseExpiresAt: new Date(90000),
      })),
    );
    await acquireHostedAiCall(orgId, connection.db, hosted, "probe");
    expect(await leases(orgId)).toHaveLength(2);
  });
});
