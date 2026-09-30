import { randomUUID } from "node:crypto";
import { createDb, schema, type TenantResourceQuotaMode } from "@pubrick/db";
import { runCreateSchema } from "@pubrick/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { type RequestAuthority, runWithRequestAuthority } from "../request-authority";
import { authorizeRequestActor } from "../request-authority-admission";
import type { RunsRepository } from "./runs.repository";

const identity = { provider: "stripe", environment: "sandbox", accountId: "acct_jobs" } as const;
const control = vi.hoisted(() => ({ mode: { mode: "self-hosted" } as TenantResourceQuotaMode }));
vi.mock("../tenant-quota", async (original) => ({
  ...(await original<typeof import("../tenant-quota")>()),
  tenantQuotaMode: () =>
    control.mode.mode === "hosted"
      ? { ...control.mode, authorizeActor: authorizeRequestActor }
      : control.mode,
}));
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("native hosted API job admission", () => {
  let connection: ReturnType<typeof createDb>;
  let runs: RunsRepository;
  const enqueue = vi.fn(async () => undefined);
  const orgIds: string[] = [];
  const planIds: string[] = [];
  const userIds: string[] = [];
  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 17).toString("base64");
    connection = createDb(url as string);
    const module = await import("./runs.repository");
    runs = new module.RunsRepository({
      enqueueGenerate: enqueue,
    } as unknown as ConstructorParameters<typeof module.RunsRepository>[0]);
    control.mode = { mode: "hosted", identity };
  });
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
    for (const userId of userIds)
      await connection.db.delete(schema.user).where(eq(schema.user.id, userId));
    await connection.pool.end();
    const { pool } = await import("../db");
    await pool.end();
  });
  async function fixture(limits: Partial<schema.BillingLimits> = {}) {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await connection.db
      .insert(schema.organization)
      .values({ id: orgId, name: "Resource fixture", slug: orgId });
    const userId = randomUUID();
    const sessionId = randomUUID();
    userIds.push(userId);
    await connection.db
      .insert(schema.user)
      .values({
        id: userId,
        name: "Verified owner",
        email: `${userId}@example.test`,
        emailVerified: true,
      });
    await connection.db
      .insert(schema.session)
      .values({
        id: sessionId,
        userId,
        token: randomUUID(),
        activeOrganizationId: orgId,
        expiresAt: new Date(Date.now() + 3600000),
      });
    await connection.db
      .insert(schema.member)
      .values({ id: randomUUID(), organizationId: orgId, userId, role: "owner" });
    const planId = randomUUID();
    planIds.push(planId);
    const priceId = `price_${planId}`;
    await connection.db.insert(schema.billingPlanVersions).values({
      id: planId,
      ...identity,
      planId: "job-fixture",
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
    const [channel] = await connection.db
      .insert(schema.channels)
      .values({
        orgId,
        brandId: brand.id,
        name: "Fixture",
        platform: "telegram",
        credentialsEncrypted: "synthetic fixture never decrypted",
      })
      .returning({ id: schema.channels.id });
    if (!channel) throw new Error("Missing channel");
    await connection.db.insert(schema.aiCredentials).values({
      orgId,
      provider: "google",
      credentialsEncrypted: "fixture never decrypted",
      defaultModel: "fixture-text-model",
    });
    await connection.db
      .insert(schema.aiTextSettings)
      .values({ orgId, provider: "google", model: "fixture-text-model" });
    const authority: RequestAuthority = Object.freeze({
      kind: "session",
      orgId,
      userId,
      sessionId,
      scope: Object.freeze({ kind: "brand", source: "body" }),
      capability: "author",
      mutation: true,
      brandId: brand.id,
      resourceId: undefined,
    });
    const create = (...args: Parameters<RunsRepository["create"]>) =>
      runWithRequestAuthority(authority, () => runs.create(...args));
    return { orgId, userId, sessionId, brandId: brand.id, channelId: channel.id, create };
  }

  function input(f: Awaited<ReturnType<typeof fixture>>) {
    return runCreateSchema.parse({
      brandId: f.brandId,
      channelIds: [f.channelId],
      brief: "Real user job",
    });
  }
  async function count(orgId: string) {
    return connection.db
      .select({ id: schema.pipelineRuns.id })
      .from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.orgId, orgId));
  }
  it("simultaneous manual requests admit one at the last paid slot", async () => {
    const f = await fixture();
    enqueue.mockClear();
    const result = await Promise.allSettled([
      f.create(f.orgId, input(f)),
      f.create(f.orgId, input(f)),
    ]);
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refusal = result.find((r) => r.status === "rejected");
    expect(refusal).toMatchObject({
      reason: { status: 409, response: { code: "resource_limit", resource: "concurrentJobs" } },
    });
    expect(await count(f.orgId)).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });
  it("expired access and replaced identity create no run or queue enqueue", async () => {
    const f = await fixture();
    enqueue.mockClear();
    control.mode = { mode: "hosted", identity: { ...identity, accountId: "replacement" } };
    await expect(f.create(f.orgId, input(f))).rejects.toMatchObject({
      status: 503,
      response: { code: "billing_identity_mismatch" },
    });
    control.mode = { mode: "hosted", identity };
    await connection.db
      .update(schema.organizationBillingState)
      .set({ accessUntil: new Date(0) })
      .where(eq(schema.organizationBillingState.orgId, f.orgId));
    await expect(f.create(f.orgId, input(f))).rejects.toMatchObject({
      status: 402,
      response: { code: "subscription_required" },
    });
    expect(await count(f.orgId)).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it("current hosted plan replaces static three while self-hosted keeps three", async () => {
    const f = await fixture({ concurrentJobs: 4 });
    for (let i = 0; i < 3; i++) await f.create(f.orgId, input(f));
    control.mode = { mode: "self-hosted" };
    await expect(f.create(f.orgId, input(f))).rejects.toMatchObject({
      status: 409,
      response: { code: "run_limit_reached" },
    });
    control.mode = { mode: "hosted", identity };
    await f.create(f.orgId, input(f));
    expect(await count(f.orgId)).toHaveLength(4);
  });
  it("enqueue failure rolls back admitted run", async () => {
    const f = await fixture();
    enqueue.mockRejectedValueOnce(new Error("queue unavailable"));
    await expect(f.create(f.orgId, input(f))).rejects.toThrow("queue unavailable");
    expect(await count(f.orgId)).toHaveLength(0);
  });
  it("refuses missing or revoked actor authority without a run or queue enqueue", async () => {
    const f = await fixture();
    enqueue.mockClear();
    await expect(runs.create(f.orgId, input(f))).rejects.toMatchObject({ status: 403 });
    await connection.db.delete(schema.member).where(eq(schema.member.userId, f.userId));
    await expect(f.create(f.orgId, input(f))).rejects.toMatchObject({ status: 403 });
    expect(await count(f.orgId)).toHaveLength(0);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
