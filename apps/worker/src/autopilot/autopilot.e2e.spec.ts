import { randomUUID } from "node:crypto";
import { schema } from "@pubrick/db";
import { and, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { quietHour } from "./rules";

const url = process.env.TEST_DATABASE_URL;

describe("autopilot schedule rules", () => {
  it("handles overnight, daytime and disabled quiet windows", () => {
    expect(quietHour(23, 22, 8)).toBe(true);
    expect(quietHour(7, 22, 8)).toBe(true);
    expect(quietHour(9, 22, 8)).toBe(false);
    expect(quietHour(12, 10, 14)).toBe(true);
    expect(quietHour(10, 10, 10)).toBe(false);
  });
});

describe.skipIf(!url)("autopilot dispatch e2e", () => {
  let db: ReturnType<typeof import("@pubrick/db").createDb>["db"];
  let pool: ReturnType<typeof import("@pubrick/db").createDb>["pool"];
  let boss: PgBoss;
  let service: InstanceType<typeof import("./autopilot.service").AutopilotService>;
  const orgId = `autopilot-${randomUUID()}`;
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
    await db.insert(schema.organization).values({ id: orgId, name: "Autopilot E2E", slug: orgId });
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
  });

  afterAll(async () => {
    if (db) await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await boss?.stop({ graceful: false, timeout: 5000 });
    await pool?.end();
  });

  it("dispatches only an approved topic once, with an atomic queue job and reviewable run", async () => {
    const [topic] = await db
      .insert(schema.topics)
      .values({ orgId, brandId, title: "A useful subject", description: "Facts to review" })
      .returning({ id: schema.topics.id });
    const topicId = topic?.id as string;
    await db.insert(schema.autopilotConfigs).values({
      orgId,
      brandId,
      enabled: true,
      channelIds: [channelId],
      timezone: "UTC",
      startHour: 0,
      quietStartHour: 0,
      quietEndHour: 0,
      dailyRunLimit: 1,
      dailySpendLimitUsd: "1.00",
    });
    expect(await service.trigger(boss, orgId, brandId)).toBe("no_approved_topic");
    await db.update(schema.topics).set({ status: "approved" }).where(eq(schema.topics.id, topicId));
    expect(await service.trigger(boss, "other-org", brandId)).toBe("disabled");
    expect(
      await Promise.all([
        service.trigger(boss, orgId, brandId),
        service.trigger(boss, orgId, brandId),
      ]),
    ).toEqual(["dispatched", "quota_full"]);
    const [dispatch] = await db
      .select({
        topicId: schema.autopilotDispatches.topicId,
        runId: schema.autopilotDispatches.runId,
      })
      .from(schema.autopilotDispatches)
      .where(eq(schema.autopilotDispatches.topicId, topicId));
    expect(dispatch?.topicId).toBe(topicId);
    const [run] = await db
      .select({ status: schema.pipelineRuns.status, input: schema.pipelineRuns.input })
      .from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, dispatch?.runId as string));
    expect(run).toEqual({
      status: "queued",
      input: {
        kind: "brief",
        text: "A useful subject\n\nFacts to review",
        channelIds: [channelId],
      },
    });
    expect(
      await boss.findJobs("generate", { data: { runId: dispatch?.runId, orgId } }),
    ).toHaveLength(1);
    expect(await service.trigger(boss, orgId, brandId)).toBe("quota_full");
  });

  it("stops admission on the recorded budget and during quiet hours", async () => {
    const first = await db
      .select({ runId: schema.autopilotDispatches.runId })
      .from(schema.autopilotDispatches)
      .where(eq(schema.autopilotDispatches.brandId, brandId))
      .limit(1);
    const firstRunId = first[0]?.runId as string;
    await db
      .update(schema.pipelineRuns)
      .set({ status: "succeeded" })
      .where(eq(schema.pipelineRuns.id, firstRunId));
    await db
      .update(schema.autopilotConfigs)
      .set({ dailyRunLimit: 5 })
      .where(eq(schema.autopilotConfigs.brandId, brandId));
    await db
      .insert(schema.topics)
      .values({ orgId, brandId, title: "Second subject", status: "approved" });
    await db.insert(schema.usageLedger).values({
      orgId,
      runId: firstRunId,
      step: "writer",
      provider: "google",
      modelId: "test",
      costUsd: "2.000000",
      costSource: "price_table",
      status: "ok",
      outcome: "completed",
    });
    expect(await service.trigger(boss, orgId, brandId)).toBe("budget_full");
    await db
      .update(schema.usageLedger)
      .set({ costUsd: null, costSource: "unknown" })
      .where(and(eq(schema.usageLedger.orgId, orgId), eq(schema.usageLedger.runId, firstRunId)));
    expect(await service.trigger(boss, orgId, brandId)).toBe("unpriced_spend");
    const timezone = "Europe/Moscow";
    const currentHour = Number(
      new Intl.DateTimeFormat("en-GB", {
        timeZone: timezone,
        hour: "2-digit",
        hourCycle: "h23",
      }).format(new Date()),
    );
    await db
      .update(schema.autopilotConfigs)
      .set({ timezone, quietStartHour: currentHour, quietEndHour: (currentHour + 1) % 24 })
      .where(eq(schema.autopilotConfigs.brandId, brandId));
    expect(await service.trigger(boss, orgId, brandId)).toBe("quiet_hours");
  });
});
