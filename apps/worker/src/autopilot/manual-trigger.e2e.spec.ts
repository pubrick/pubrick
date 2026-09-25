import { randomUUID } from "node:crypto";
import { schema } from "@pubrick/db";
import { MAX_BRIEF_LENGTH, MAX_CONCURRENT_RUNS } from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("manual Autopilot decision history", () => {
  let db: ReturnType<typeof import("@pubrick/db").createDb>["db"];
  let pool: ReturnType<typeof import("@pubrick/db").createDb>["pool"];
  let boss: PgBoss;
  let service: InstanceType<typeof import("./autopilot.service").AutopilotService>;
  const orgId = `manual-auto-${randomUUID()}`;
  let brandId: string;
  let channelId: string;
  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    const { AutopilotService } = await import("./autopilot.service");
    service = new AutopilotService();
    ({ db, pool } = (await import("@pubrick/db")).createDb(url as string));
    boss = new PgBoss({ connectionString: url as string, supervise: false, schedule: false });
    boss.on("error", () => {});
    await boss.start();
    await boss.createQueue("generate");
    await db
      .insert(schema.organization)
      .values({ id: orgId, name: "Manual Autopilot E2E", slug: orgId });
    const [brand] = await db
      .insert(schema.brands)
      .values({ orgId, name: "Brand" })
      .returning({ id: schema.brands.id });
    brandId = brand?.id as string;
    const [channel] = await db
      .insert(schema.channels)
      .values({ orgId, brandId, platform: "telegram", name: "Main", credentialsEncrypted: "test" })
      .returning({ id: schema.channels.id });
    channelId = channel?.id as string;
    await db.insert(schema.autopilotConfigs).values({
      orgId,
      brandId,
      enabled: false,
      channelIds: [channelId],
      timezone: "UTC",
      startHour: 0,
      quietStartHour: 0,
      quietEndHour: 0,
      dailyRunLimit: 1,
      dailySpendLimitUsd: "1.00",
    });
  });
  afterAll(async () => {
    if (db) await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await boss?.stop({ graceful: false, timeout: 5000 });
    await pool?.end();
  });

  async function attempt(forBrandId = brandId) {
    const [row] = await db
      .insert(schema.autopilotManualAttempts)
      .values({ orgId, brandId: forBrandId })
      .returning({ id: schema.autopilotManualAttempts.id });
    return { orgId, brandId: forBrandId, attemptId: row?.id as string };
  }
  async function result(attemptId: string) {
    const [row] = await db
      .select({
        status: schema.autopilotManualAttempts.status,
        decision: schema.autopilotManualAttempts.decision,
        runId: schema.autopilotManualAttempts.runId,
      })
      .from(schema.autopilotManualAttempts)
      .where(
        and(
          eq(schema.autopilotManualAttempts.orgId, orgId),
          eq(schema.autopilotManualAttempts.id, attemptId),
        ),
      );
    return row;
  }

  it("records skipped decisions without paid work and dispatches exactly one reviewable draft", async () => {
    const disabled = await attempt();
    await service.handleManual(boss, disabled);
    expect(await result(disabled.attemptId)).toEqual({
      status: "completed",
      decision: "disabled",
      runId: null,
    });
    await db
      .update(schema.autopilotConfigs)
      .set({ enabled: true })
      .where(eq(schema.autopilotConfigs.brandId, brandId));
    const empty = await attempt();
    await service.handleManual(boss, empty);
    expect(await result(empty.attemptId)).toEqual({
      status: "completed",
      decision: "no_approved_topic",
      runId: null,
    });
    expect(
      await db
        .select({ id: schema.pipelineRuns.id })
        .from(schema.pipelineRuns)
        .where(eq(schema.pipelineRuns.brandId, brandId)),
    ).toHaveLength(0);
    const [topic] = await db
      .insert(schema.topics)
      .values({ orgId, brandId, title: "Editorial topic", status: "approved" })
      .returning({ id: schema.topics.id });
    const eligible = await attempt();
    await service.handleManual(boss, eligible);
    const dispatched = await result(eligible.attemptId);
    expect(dispatched).toMatchObject({ status: "completed", decision: "dispatched" });
    expect(dispatched?.runId).toBeTruthy();
    expect(
      await db
        .select({ id: schema.autopilotDispatches.id })
        .from(schema.autopilotDispatches)
        .where(eq(schema.autopilotDispatches.topicId, topic?.id as string)),
    ).toHaveLength(1);
    expect(
      await boss.findJobs("generate", { data: { runId: dispatched?.runId, orgId } }),
    ).toHaveLength(1);
    const duplicate = await attempt();
    await service.handleManual(boss, duplicate);
    expect(await result(duplicate.attemptId)).toEqual({
      status: "completed",
      decision: "quota_full",
      runId: null,
    });
    expect(
      await db
        .select({ id: schema.pipelineRuns.id })
        .from(schema.pipelineRuns)
        .where(eq(schema.pipelineRuns.brandId, brandId)),
    ).toHaveLength(1);
  });

  it("rolls back a failed generation enqueue and closes the attempt; DLQ and sweep close abandoned work", async () => {
    const [topic] = await db
      .insert(schema.topics)
      .values({ orgId, brandId, title: "Another topic", status: "approved" })
      .returning({ id: schema.topics.id });
    await db
      .update(schema.autopilotConfigs)
      .set({ dailyRunLimit: 5 })
      .where(eq(schema.autopilotConfigs.brandId, brandId));
    await db
      .update(schema.pipelineRuns)
      .set({ status: "succeeded" })
      .where(eq(schema.pipelineRuns.brandId, brandId));
    const queued = await attempt();
    const send = vi.spyOn(boss, "send").mockResolvedValueOnce(null);
    try {
      await service.handleManual(boss, queued);
    } finally {
      send.mockRestore();
    }
    expect(await result(queued.attemptId)).toEqual({
      status: "failed",
      decision: "worker_failed",
      runId: null,
    });
    expect(
      await db
        .select({ id: schema.autopilotDispatches.id })
        .from(schema.autopilotDispatches)
        .where(eq(schema.autopilotDispatches.topicId, topic?.id as string)),
    ).toHaveLength(0);
    const dead = await attempt();
    await service.exhausted(dead);
    expect(await result(dead.attemptId)).toMatchObject({
      status: "failed",
      decision: "worker_failed",
    });
    const stale = await attempt();
    await db
      .update(schema.autopilotManualAttempts)
      .set({ createdAt: sql`clock_timestamp() - interval '11 minutes'` })
      .where(eq(schema.autopilotManualAttempts.id, stale.attemptId));
    await service.sweepManual();
    expect(await result(stale.attemptId)).toMatchObject({
      status: "failed",
      decision: "worker_failed",
    });
  });

  it("records every admission refusal through the same manual decision transaction", async () => {
    const [brand] = await db
      .insert(schema.brands)
      .values({ orgId, name: "Admission gates" })
      .returning({ id: schema.brands.id });
    const gateBrand = brand?.id as string;
    const [channel] = await db
      .insert(schema.channels)
      .values({
        orgId,
        brandId: gateBrand,
        platform: "telegram",
        name: "Gate channel",
        credentialsEncrypted: "test",
      })
      .returning({ id: schema.channels.id });
    const gateChannel = channel?.id as string;
    await db.insert(schema.autopilotConfigs).values({
      orgId,
      brandId: gateBrand,
      enabled: true,
      channelIds: [gateChannel],
      timezone: "UTC",
      startHour: 0,
      quietStartHour: 0,
      quietEndHour: 0,
      dailyRunLimit: 5,
      dailySpendLimitUsd: "1.00",
    });
    async function check(decision: string) {
      const request = await attempt(gateBrand);
      await service.handleManual(boss, request);
      expect(await result(request.attemptId)).toMatchObject({ status: "completed", decision });
      return request;
    }
    const utcHour = new Date().getUTCHours();
    const timezone = utcHour === 23 ? "Pacific/Honolulu" : "UTC";
    const localHour = Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        hourCycle: "h23",
      }).format(new Date()),
    );
    await db
      .update(schema.autopilotConfigs)
      .set({ timezone, startHour: localHour + 1 })
      .where(eq(schema.autopilotConfigs.brandId, gateBrand));
    await check("before_start");
    await db
      .update(schema.autopilotConfigs)
      .set({ startHour: 0, quietStartHour: localHour, quietEndHour: (localHour + 1) % 24 })
      .where(eq(schema.autopilotConfigs.brandId, gateBrand));
    await check("quiet_hours");
    await db
      .update(schema.autopilotConfigs)
      .set({ quietStartHour: 0, quietEndHour: 0, channelIds: [] })
      .where(eq(schema.autopilotConfigs.brandId, gateBrand));
    await check("channels_missing");
    await db
      .update(schema.autopilotConfigs)
      .set({ channelIds: [gateChannel] })
      .where(eq(schema.autopilotConfigs.brandId, gateBrand));
    const [topic] = await db
      .insert(schema.topics)
      .values({
        orgId,
        brandId: gateBrand,
        title: "Long brief",
        description: "x".repeat(MAX_BRIEF_LENGTH + 1),
        status: "approved",
      })
      .returning({ id: schema.topics.id });
    await check("invalid_brief");
    await db
      .update(schema.topics)
      .set({ description: "Ready" })
      .where(eq(schema.topics.id, topic?.id as string));
    const dispatchedRequest = await check("dispatched");
    const dispatched = await result(dispatchedRequest.attemptId);
    await check("run_in_progress");
    await db
      .update(schema.pipelineRuns)
      .set({ status: "succeeded" })
      .where(eq(schema.pipelineRuns.id, dispatched?.runId as string));
    const [otherBrand] = await db
      .insert(schema.brands)
      .values({ orgId, name: "Busy org" })
      .returning({ id: schema.brands.id });
    const fillerIds: string[] = [];
    for (let n = 0; n < MAX_CONCURRENT_RUNS; n++) {
      const [run] = await db
        .insert(schema.pipelineRuns)
        .values({
          orgId,
          brandId: otherBrand?.id as string,
          input: { kind: "brief", text: `Busy ${n}`, channelIds: [] },
        })
        .returning({ id: schema.pipelineRuns.id });
      fillerIds.push(run?.id as string);
    }
    await check("org_busy");
    await db
      .delete(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.brandId, otherBrand?.id as string));
    await db.insert(schema.usageLedger).values({
      orgId,
      runId: dispatched?.runId as string,
      step: "writer",
      provider: "google",
      modelId: "test",
      costUsd: "2.000000",
      costSource: "price_table",
      status: "ok",
      outcome: "completed",
    });
    await check("budget_full");
    await db
      .update(schema.usageLedger)
      .set({ costUsd: null, costSource: "unknown" })
      .where(eq(schema.usageLedger.runId, dispatched?.runId as string));
    await check("unpriced_spend");
    await db
      .update(schema.autopilotConfigs)
      .set({ dailyRunLimit: 1 })
      .where(eq(schema.autopilotConfigs.brandId, gateBrand));
    await check("quota_full");
    expect(fillerIds).toHaveLength(MAX_CONCURRENT_RUNS);
  });
});
