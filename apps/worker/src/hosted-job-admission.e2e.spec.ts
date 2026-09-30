import { randomUUID } from "node:crypto";
import { createDb, schema, type TenantResourceQuotaMode } from "@pubrick/db";
import { GENERATE_QUEUE } from "@pubrick/shared";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AutopilotService } from "./autopilot/autopilot.service";
import type { CalendarService } from "./calendar/calendar.service";

const identity = { provider: "stripe", environment: "sandbox", accountId: "acct_jobs" } as const;
const control = vi.hoisted(() => ({ mode: { mode: "self-hosted" } as TenantResourceQuotaMode }));
vi.mock("./hosted-job-admission", async (original) => ({
  ...(await original<typeof import("./hosted-job-admission")>()),
  workerJobQuotaMode: () => control.mode,
}));
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("native hosted worker job admission", () => {
  let connection: ReturnType<typeof createDb>;
  let boss: PgBoss;
  let calendar: CalendarService;
  let autopilot: AutopilotService;
  const orgIds: string[] = [];
  const planIds: string[] = [];
  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 17).toString("base64");
    connection = createDb(url as string);
    boss = new PgBoss({ connectionString: url as string });
    await boss.start();
    await boss.createQueue(GENERATE_QUEUE);
    const c = await import("./calendar/calendar.service");
    const a = await import("./autopilot/autopilot.service");
    calendar = new c.CalendarService();
    autopilot = new a.AutopilotService();
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
    await boss?.stop({ graceful: false, timeout: 5000 });
    await connection.pool.end();
    const { pool } = await import("./db");
    await pool.end();
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
      .values({ orgId, brandId: brand.id, name: "Fixture", platform: "telegram" })
      .returning({ id: schema.channels.id });
    if (!channel) throw new Error("Missing channel");
    await connection.db.insert(schema.aiCredentials).values({
      orgId,
      provider: "google",
      credentialsEncrypted: "fixture never decrypted",
      defaultModel: "fixture-text-model",
    });
    await connection.db.insert(schema.autopilotConfigs).values({
      orgId,
      brandId: brand.id,
      enabled: true,
      channelIds: [channel.id],
      timezone: "UTC",
      startHour: 0,
      quietStartHour: 0,
      quietEndHour: 0,
      dailyRunLimit: 5,
      dailySpendLimitUsd: "100",
    });
    const [topic] = await connection.db
      .insert(schema.topics)
      .values({
        orgId,
        brandId: brand.id,
        title: "Approved subject",
        description: "Reviewed facts",
        status: "approved",
      })
      .returning({ id: schema.topics.id });
    const [slot] = await connection.db
      .insert(schema.calendarSlots)
      .values({
        orgId,
        brandId: brand.id,
        scheduledAt: new Date(0),
        brief: "Scheduled reviewable job",
        channelIds: [channel.id],
      })
      .returning({ id: schema.calendarSlots.id });
    if (!topic || !slot) throw new Error("Missing topic/slot");
    return { orgId, brandId: brand.id, channelId: channel.id, topicId: topic.id, slotId: slot.id };
  }

  async function runs(orgId: string) {
    return connection.db
      .select({ id: schema.pipelineRuns.id })
      .from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.orgId, orgId));
  }
  it("calendar and autopilot race for the same last paid slot and enqueue exactly one durable job", async () => {
    const f = await fixture();
    await Promise.all([
      calendar.trigger(boss, f.orgId, f.slotId),
      autopilot.trigger(boss, f.orgId, f.brandId),
    ]);
    const live = await runs(f.orgId);
    expect(live).toHaveLength(1);
    const jobs = await boss.findJobs(GENERATE_QUEUE, { data: { orgId: f.orgId } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toMatchObject({ runId: live[0]?.id, orgId: f.orgId });
  });
  it("expired access leaves calendar slot, topic and queue untouched", async () => {
    const f = await fixture();
    await connection.db
      .update(schema.organizationBillingState)
      .set({ accessUntil: new Date(0) })
      .where(eq(schema.organizationBillingState.orgId, f.orgId));
    const [before] = await connection.db
      .select()
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.id, f.slotId));
    await calendar.trigger(boss, f.orgId, f.slotId);
    const [after] = await connection.db
      .select()
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.id, f.slotId));
    expect(after).toEqual(before);
    expect(await runs(f.orgId)).toHaveLength(0);
    expect(await boss.findJobs(GENERATE_QUEUE, { data: { orgId: f.orgId } })).toHaveLength(0);
    expect(
      await connection.db
        .select()
        .from(schema.aiTextSettings)
        .where(eq(schema.aiTextSettings.orgId, f.orgId)),
    ).toHaveLength(0);
  });
  it("refused autopilot completes manual bookkeeping without a run or topic claim", async () => {
    const f = await fixture();
    await connection.db
      .update(schema.organizationBillingState)
      .set({ access: false })
      .where(eq(schema.organizationBillingState.orgId, f.orgId));
    const attemptId = randomUUID();
    await connection.db
      .insert(schema.autopilotManualAttempts)
      .values({ id: attemptId, orgId: f.orgId, brandId: f.brandId, status: "running" });
    expect(await autopilot.trigger(boss, f.orgId, f.brandId, attemptId)).toBe("org_busy");
    const [attempt] = await connection.db
      .select()
      .from(schema.autopilotManualAttempts)
      .where(eq(schema.autopilotManualAttempts.id, attemptId));
    expect(attempt).toMatchObject({ status: "completed", decision: "org_busy", runId: null });
    expect(await runs(f.orgId)).toHaveLength(0);
    expect(
      await connection.db
        .select()
        .from(schema.autopilotDispatches)
        .where(eq(schema.autopilotDispatches.orgId, f.orgId)),
    ).toHaveLength(0);
    const [topic] = await connection.db
      .select()
      .from(schema.topics)
      .where(eq(schema.topics.id, f.topicId));
    expect(topic?.status).toBe("approved");
  });
  it("replaced operator is refused until the configured identity matches the current plan", async () => {
    const f = await fixture();
    control.mode = { mode: "hosted", identity: { ...identity, accountId: "replacement" } };
    await calendar.trigger(boss, f.orgId, f.slotId);
    expect(await runs(f.orgId)).toHaveLength(0);
    control.mode = { mode: "hosted", identity };
    await calendar.trigger(boss, f.orgId, f.slotId);
    expect(await runs(f.orgId)).toHaveLength(1);
  });
});
