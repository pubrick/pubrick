import { randomUUID } from "node:crypto";
import { schema } from "@pubrick/db";
import {
  MANUAL_TOPIC_PLAN_DLQ,
  MANUAL_TOPIC_PLAN_QUEUE,
  MANUAL_TOPIC_PLAN_QUEUE_OPTIONS,
} from "@pubrick/shared";
import { and, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const orgId = `topic-planner-${randomUUID()}`;

describe.skipIf(!url)("approved topic calendar planning", () => {
  let db: ReturnType<typeof import("@pubrick/db").createDb>["db"];
  let pool: ReturnType<typeof import("@pubrick/db").createDb>["pool"];
  let planner: InstanceType<typeof import("./topic-planner.service").TopicPlannerService>;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    const { TopicPlannerService } = await import("./topic-planner.service");
    planner = new TopicPlannerService();
    ({ db, pool } = (await import("@pubrick/db")).createDb(url as string));
    await db.insert(schema.organization).values({ id: orgId, slug: orgId, name: "Planner E2E" });
  });

  afterAll(async () => {
    if (db) await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await pool?.end();
  });

  async function brand(
    config: {
      timezone?: string;
      planningDailyLimit?: number;
      autoPlanTopics?: boolean;
      enabled?: boolean;
      channelIds?: string[];
    } = {},
  ) {
    const [created] = await db
      .insert(schema.brands)
      .values({ orgId, name: "Planner brand" })
      .returning({ id: schema.brands.id });
    const brandId = created?.id as string;
    const [channel] = await db
      .insert(schema.channels)
      .values({
        orgId,
        brandId,
        platform: "telegram",
        name: "Channel",
        credentialsEncrypted: "test-only",
      })
      .returning({ id: schema.channels.id });
    const channelId = channel?.id as string;
    await db.insert(schema.autopilotConfigs).values({
      orgId,
      brandId,
      enabled: config.enabled ?? false,
      autoPlanTopics: config.autoPlanTopics ?? true,
      channelIds: config.channelIds ?? [channelId],
      timezone: config.timezone ?? "UTC",
      planningDailyLimit: config.planningDailyLimit ?? 1,
    });
    return { brandId, channelId };
  }

  async function topic(
    brandId: string,
    plannedDate: string,
    priority = 5,
    status: "approved" | "idea" = "approved",
  ) {
    const [created] = await db
      .insert(schema.topics)
      .values({
        orgId,
        brandId,
        title: `Topic ${randomUUID()}`,
        description: "Reviewed facts",
        plannedDate,
        priority,
        status,
      })
      .returning({ id: schema.topics.id });
    return created?.id as string;
  }

  async function slots(brandId: string) {
    return db
      .select()
      .from(schema.calendarSlots)
      .where(and(eq(schema.calendarSlots.orgId, orgId), eq(schema.calendarSlots.brandId, brandId)));
  }

  it("requires the separate planning opt-in, but not direct autopilot", async () => {
    const { brandId, channelId } = await brand({ autoPlanTopics: false, enabled: true });
    const topicId = await topic(brandId, "2026-09-25");
    const now = new Date("2026-09-24T08:00:00Z");
    expect(await planner.planBrand(orgId, brandId, now)).toBe(0);
    await db
      .update(schema.autopilotConfigs)
      .set({ autoPlanTopics: true, enabled: false })
      .where(eq(schema.autopilotConfigs.brandId, brandId));
    await planner.scan(now);
    const [slot] = await slots(brandId);
    expect(slot).toMatchObject({ topicId, channelIds: [channelId], topicRevision: 1 });
    expect(slot?.topicTitle).toMatch(/^Topic /);
    expect(slot?.scheduledAt.toISOString()).toBe("2026-09-25T10:00:00.000Z");
    expect(slot?.runId).toBeNull();
  });

  it("copies an approved article format and editorial keywords into automatic slots", async () => {
    const { brandId } = await brand();
    const topicId = await topic(brandId, "2026-09-25");
    await db
      .update(schema.topics)
      .set({ contentType: "expert_article", seoKeywords: ["local guide"] })
      .where(eq(schema.topics.id, topicId));
    expect(await planner.planBrand(orgId, brandId, new Date("2026-09-24T08:00:00Z"))).toBe(1);
    expect((await slots(brandId))[0]).toMatchObject({
      topicId,
      contentType: "expert_article",
      seoKeywords: ["local guide"],
    });
  });

  it("counts manual slots in the local day cap and chooses higher priority first", async () => {
    const { brandId, channelId } = await brand({ planningDailyLimit: 2 });
    const now = new Date("2026-09-24T08:00:00Z");
    await db.insert(schema.calendarSlots).values({
      orgId,
      brandId,
      scheduledAt: new Date("2026-09-25T15:00:00Z"),
      brief: "Manual plan",
      channelIds: [channelId],
    });
    const low = await topic(brandId, "2026-09-25", 2);
    const high = await topic(brandId, "2026-09-25", 9);
    await topic(brandId, "2026-09-25", 10, "idea");
    expect(await planner.planBrand(orgId, brandId, now)).toBe(1);
    expect((await slots(brandId)).map((slot) => slot.topicId)).toContain(high);
    expect((await slots(brandId)).map((slot) => slot.topicId)).not.toContain(low);
  });

  it("is idempotent across simultaneous scanners and existing manual linked slots", async () => {
    const { brandId, channelId } = await brand({ planningDailyLimit: 2 });
    const existing = await topic(brandId, "2026-09-25", 9);
    const fresh = await topic(brandId, "2026-09-26", 7);
    await db.insert(schema.calendarSlots).values({
      orgId,
      brandId,
      scheduledAt: new Date("2026-09-25T12:00:00Z"),
      brief: "Manual linked topic",
      topicId: existing,
      topicTitle: "Manual linked topic",
      topicDescription: "",
      topicUpdatedAt: new Date(),
      topicRevision: 1,
      channelIds: [channelId],
    });
    const now = new Date("2026-09-24T08:00:00Z");
    expect(
      (
        await Promise.all([
          planner.planBrand(orgId, brandId, now),
          planner.planBrand(orgId, brandId, now),
        ])
      ).sort(),
    ).toEqual([0, 1]);
    expect(await planner.planBrand(orgId, brandId, now)).toBe(0);
    const all = await slots(brandId);
    expect(all).toHaveLength(2);
    expect(all.filter((slot) => slot.topicId === existing)).toHaveLength(1);
    expect(all.filter((slot) => slot.topicId === fresh)).toHaveLength(1);

    await db.delete(schema.calendarSlots).where(eq(schema.calendarSlots.topicId, fresh));
    await db.update(schema.topics).set({ plannedDate: null }).where(eq(schema.topics.id, fresh));
    expect(await planner.planBrand(orgId, brandId, now)).toBe(0);
  });

  it("schedules 10:00 in the configured timezone and skips elapsed instants", async () => {
    const { brandId } = await brand({ timezone: "Asia/Tokyo", planningDailyLimit: 3 });
    const today = await topic(brandId, "2026-09-24");
    const tomorrow = await topic(brandId, "2026-09-25");
    await topic(brandId, "2026-10-08"); // Outside the next 14 local days.
    const now = new Date("2026-09-24T01:01:00Z"); // 10:01 local.
    expect(await planner.planBrand(orgId, brandId, now)).toBe(1);
    const [slot] = await slots(brandId);
    expect(slot?.topicId).toBe(tomorrow);
    expect(slot?.topicId).not.toBe(today);
    expect(slot?.scheduledAt.toISOString()).toBe("2026-09-25T01:00:00.000Z");
  });

  it("keeps the local 10:00 schedule across daylight saving changes", async () => {
    const spring = await brand({ timezone: "America/New_York" });
    await topic(spring.brandId, "2027-03-14");
    expect(await planner.planBrand(orgId, spring.brandId, new Date("2027-03-13T16:00:00Z"))).toBe(
      1,
    );
    expect((await slots(spring.brandId))[0]?.scheduledAt.toISOString()).toBe(
      "2027-03-14T14:00:00.000Z",
    );

    const autumn = await brand({ timezone: "America/New_York" });
    await topic(autumn.brandId, "2027-11-07");
    expect(await planner.planBrand(orgId, autumn.brandId, new Date("2027-11-06T16:00:00Z"))).toBe(
      1,
    );
    expect((await slots(autumn.brandId))[0]?.scheduledAt.toISOString()).toBe(
      "2027-11-07T15:00:00.000Z",
    );
  });

  it("skips missing selected channels and does not create a partial plan", async () => {
    const { brandId } = await brand({ channelIds: [randomUUID()] });
    await topic(brandId, "2026-09-25");
    expect(await planner.planBrand(orgId, brandId, new Date("2026-09-24T08:00:00Z"))).toBe(0);
    expect(await slots(brandId)).toHaveLength(0);
  });

  it("completes an empty manual pass and preserves slot attribution across repeat delivery", async () => {
    const { brandId } = await brand();
    const [empty] = await db
      .insert(schema.manualTopicPlanAttempts)
      .values({ orgId, brandId })
      .returning({ id: schema.manualTopicPlanAttempts.id });
    const emptyJob = { orgId, brandId, attemptId: empty?.id as string };
    await planner.handleManual(emptyJob);
    const [emptyResult] = await db
      .select()
      .from(schema.manualTopicPlanAttempts)
      .where(eq(schema.manualTopicPlanAttempts.id, emptyJob.attemptId));
    expect(emptyResult).toMatchObject({ status: "completed", createdCount: 0, errorCode: null });
    expect(emptyResult?.startedAt).toBeInstanceOf(Date);
    expect(emptyResult?.completedAt).toBeInstanceOf(Date);

    const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    await topic(brandId, day);
    const [created] = await db
      .insert(schema.manualTopicPlanAttempts)
      .values({ orgId, brandId })
      .returning({ id: schema.manualTopicPlanAttempts.id });
    const job = { orgId, brandId, attemptId: created?.id as string };
    await planner.handleManual(job);
    await planner.handleManual(job);
    const [result] = await db
      .select()
      .from(schema.manualTopicPlanAttempts)
      .where(eq(schema.manualTopicPlanAttempts.id, job.attemptId));
    expect(result).toMatchObject({ status: "completed", createdCount: 1, errorCode: null });
    const planned = await slots(brandId);
    expect(planned).toHaveLength(1);
    expect(planned[0]?.manualPlanAttemptId).toBe(job.attemptId);
    await db
      .delete(schema.calendarSlots)
      .where(eq(schema.calendarSlots.id, planned[0]?.id as string));
    const [afterRemoval] = await db
      .select({ createdCount: schema.manualTopicPlanAttempts.createdCount })
      .from(schema.manualTopicPlanAttempts)
      .where(eq(schema.manualTopicPlanAttempts.id, job.attemptId));
    expect(afterRemoval?.createdCount).toBe(1);
  });

  it("retries a failed pass without a partial slot, then records a safe terminal failure", async () => {
    const { brandId } = await brand();
    const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    await topic(brandId, day);
    await db
      .update(schema.autopilotConfigs)
      .set({ timezone: "Not/A_Timezone" })
      .where(eq(schema.autopilotConfigs.brandId, brandId));
    const [created] = await db
      .insert(schema.manualTopicPlanAttempts)
      .values({ orgId, brandId })
      .returning({ id: schema.manualTopicPlanAttempts.id });
    const job = { orgId, brandId, attemptId: created?.id as string };
    await expect(planner.handleManual(job)).rejects.toThrow();
    expect(await slots(brandId)).toHaveLength(0);
    const [pending] = await db
      .select()
      .from(schema.manualTopicPlanAttempts)
      .where(eq(schema.manualTopicPlanAttempts.id, job.attemptId));
    expect(pending).toMatchObject({ status: "running", createdCount: 0, errorCode: null });
    await db
      .update(schema.autopilotConfigs)
      .set({ timezone: "UTC" })
      .where(eq(schema.autopilotConfigs.brandId, brandId));
    await planner.handleManual(job);
    const [recovered] = await db
      .select()
      .from(schema.manualTopicPlanAttempts)
      .where(eq(schema.manualTopicPlanAttempts.id, job.attemptId));
    expect(recovered).toMatchObject({ status: "completed", createdCount: 1, errorCode: null });
    expect(await slots(brandId)).toHaveLength(1);

    const secondBrand = await brand();
    await db
      .update(schema.autopilotConfigs)
      .set({ timezone: "Not/A_Timezone" })
      .where(eq(schema.autopilotConfigs.brandId, secondBrand.brandId));
    const [failed] = await db
      .insert(schema.manualTopicPlanAttempts)
      .values({ orgId, brandId: secondBrand.brandId })
      .returning({ id: schema.manualTopicPlanAttempts.id });
    const failedJob = { orgId, brandId: secondBrand.brandId, attemptId: failed?.id as string };
    await expect(planner.handleManual(failedJob)).rejects.toThrow();
    await planner.exhausted(failedJob);
    const [terminal] = await db
      .select()
      .from(schema.manualTopicPlanAttempts)
      .where(eq(schema.manualTopicPlanAttempts.id, failedJob.attemptId));
    expect(terminal).toMatchObject({
      status: "failed",
      errorCode: "worker_failed",
      createdCount: 0,
    });
    expect(terminal?.completedAt).toBeInstanceOf(Date);
    await planner.handleManual(failedJob);
    expect(await slots(secondBrand.brandId)).toHaveLength(0);
  });

  it("processes a topic-plan job queued before attempt IDs existed", async () => {
    const { brandId } = await brand();
    const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    await topic(brandId, day);
    await planner.handleManual({ orgId, brandId, attemptId: undefined as unknown as string });
    expect(await slots(brandId)).toHaveLength(1);
    expect((await slots(brandId))[0]?.manualPlanAttemptId).toBeNull();
  });

  it("does not fail an old attempt while its queue job is still waiting", async () => {
    const { brandId } = await brand();
    const old = new Date(Date.now() - 11 * 60_000);
    const [queued] = await db
      .insert(schema.manualTopicPlanAttempts)
      .values({ orgId, brandId, createdAt: old })
      .returning({ id: schema.manualTopicPlanAttempts.id });
    const [orphaned] = await db
      .insert(schema.manualTopicPlanAttempts)
      .values({ orgId, brandId, createdAt: old })
      .returning({ id: schema.manualTopicPlanAttempts.id });
    if (!queued || !orphaned) throw new Error("Manual planning attempt insert returned no row");
    const boss = new PgBoss({ connectionString: url as string, supervise: false, schedule: false });
    boss.on("error", () => {});
    await boss.start();
    try {
      await boss.createQueue(MANUAL_TOPIC_PLAN_DLQ);
      await boss.createQueue(MANUAL_TOPIC_PLAN_QUEUE, { ...MANUAL_TOPIC_PLAN_QUEUE_OPTIONS });
      await boss.send(
        MANUAL_TOPIC_PLAN_QUEUE,
        { orgId, brandId, attemptId: queued.id },
        { id: queued.id, group: { id: orgId } },
      );
      await planner.sweepManual();
      const rows = await db
        .select({
          id: schema.manualTopicPlanAttempts.id,
          status: schema.manualTopicPlanAttempts.status,
        })
        .from(schema.manualTopicPlanAttempts)
        .where(eq(schema.manualTopicPlanAttempts.brandId, brandId));
      expect(rows.find((row) => row.id === queued.id)?.status).toBe("queued");
      expect(rows.find((row) => row.id === orphaned.id)?.status).toBe("failed");
    } finally {
      await boss.stop({ graceful: false, timeout: 5000 });
    }
  });
});
