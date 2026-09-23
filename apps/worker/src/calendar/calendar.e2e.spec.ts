import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("planned calendar generation", () => {
  let db: Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["db"];
  let pool: Awaited<ReturnType<typeof import("@pubrick/db").createDb>>["pool"];
  let schema: typeof import("@pubrick/db").schema;
  let boss: InstanceType<typeof import("pg-boss").PgBoss>;
  let service: InstanceType<typeof import("./calendar.service").CalendarService>;
  let orgId: string;
  let brandId: string;
  let channelId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    const dbPackage = await import("@pubrick/db");
    schema = dbPackage.schema;
    ({ db, pool } = dbPackage.createDb(url as string));
    const { PgBoss } = await import("pg-boss");
    boss = new PgBoss({ connectionString: url as string, supervise: false, schedule: false });
    boss.on("error", (error: Error) => console.error("pg-boss calendar test", error));
    await boss.start();
    await boss.createQueue("generate");
    const { CalendarService } = await import("./calendar.service");
    service = new CalendarService();
    orgId = `calendar-e2e-${randomUUID()}`;
    await db.insert(schema.organization).values({ id: orgId, name: "Calendar E2E", slug: orgId });
    const [brand] = await db
      .insert(schema.brands)
      .values({ orgId, name: "Brand" })
      .returning({ id: schema.brands.id });
    brandId = brand?.id as string;
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
    channelId = channel?.id as string;
  });

  afterAll(async () => {
    if (db && orgId) {
      const { eq } = await import("drizzle-orm");
      await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    }
    await boss?.stop({ graceful: false, timeout: 5_000 });
    await pool?.end();
  });

  async function seed(channelIds = [channelId]) {
    const [slot] = await db
      .insert(schema.calendarSlots)
      .values({
        orgId,
        brandId,
        scheduledAt: new Date(Date.now() - 60_000),
        brief: "A useful topic",
        channelIds,
      })
      .returning({ id: schema.calendarSlots.id });
    return slot?.id as string;
  }

  it("creates one real queued run and never queues the same slot twice", async () => {
    const { eq } = await import("drizzle-orm");
    const slotId = await seed();
    await service.trigger(boss, orgId, slotId);
    await service.trigger(boss, orgId, slotId);
    const [slot] = await db
      .select({ runId: schema.calendarSlots.runId })
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.id, slotId));
    expect(slot?.runId).toBeTruthy();
    const rows = await db
      .select({ orgId: schema.pipelineRuns.orgId, input: schema.pipelineRuns.input })
      .from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, slot?.runId as string));
    expect(rows).toEqual([
      { orgId, input: { kind: "brief", text: "A useful topic", channelIds: [channelId] } },
    ]);
    const jobs = await boss.findJobs("generate", { data: { runId: slot?.runId, orgId } });
    expect(jobs).toHaveLength(1);
  });

  it("defers when three runs are live instead of spending past the admission cap", async () => {
    const { eq } = await import("drizzle-orm");
    const slotId = await seed();
    const inserted = await db
      .insert(schema.pipelineRuns)
      .values(
        Array.from({ length: 2 }, () => ({
          orgId,
          brandId,
          input: { kind: "brief" as const, text: "Existing", channelIds: [channelId] },
        })),
      )
      .returning({ id: schema.pipelineRuns.id });
    await service.trigger(boss, orgId, slotId);
    const [slot] = await db
      .select({ runId: schema.calendarSlots.runId, retryAfter: schema.calendarSlots.retryAfter })
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.id, slotId));
    expect(slot?.runId).toBeNull();
    expect(slot?.retryAfter?.getTime()).toBeGreaterThan(Date.now());
    await db
      .delete(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, inserted[0]?.id as string));
    await db
      .delete(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, inserted[1]?.id as string));
  });

  it("records a removed channel and cannot trigger a slot from another organization", async () => {
    const { eq } = await import("drizzle-orm");
    const slotId = await seed([randomUUID()]);
    await service.trigger(boss, "another-org", slotId);
    await service.trigger(boss, orgId, slotId);
    const [slot] = await db
      .select({ runId: schema.calendarSlots.runId, errorCode: schema.calendarSlots.errorCode })
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.id, slotId));
    expect(slot).toEqual({ runId: null, errorCode: "channels_missing" });
  });
});
