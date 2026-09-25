import { randomUUID } from "node:crypto";
import { schema } from "@pubrick/db";
import { and, eq } from "drizzle-orm";
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
});
