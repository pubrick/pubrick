import { randomUUID } from "node:crypto";
import { schema } from "@pubrick/db";
import { eq, sql } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("scheduled Autopilot decisions", () => {
  let db: ReturnType<typeof import("@pubrick/db").createDb>["db"];
  let pool: ReturnType<typeof import("@pubrick/db").createDb>["pool"];
  let boss: PgBoss;
  let service: InstanceType<typeof import("./autopilot.service").AutopilotService>;
  const orgId = `scan-${randomUUID()}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    const { AutopilotService } = await import("./autopilot.service");
    service = new AutopilotService();
    ({ db, pool } = (await import("@pubrick/db")).createDb(url as string));
    boss = new PgBoss({ connectionString: url as string, supervise: false, schedule: false });
    boss.on("error", () => {});
    await boss.start();
    await boss.createQueue("generate");
    await db.insert(schema.organization).values({ id: orgId, name: "Scan E2E", slug: orgId });
  });
  afterAll(async () => {
    if (db) await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await boss?.stop({ graceful: false, timeout: 5000 });
    await pool?.end();
  });

  async function brand(withTopic: boolean) {
    const [created] = await db
      .insert(schema.brands)
      .values({ orgId, name: randomUUID() })
      .returning({ id: schema.brands.id });
    const brandId = created?.id as string;
    const [channel] = await db
      .insert(schema.channels)
      .values({ orgId, brandId, platform: "telegram", name: "Main", credentialsEncrypted: "test" })
      .returning({ id: schema.channels.id });
    await db.insert(schema.autopilotConfigs).values({
      orgId,
      brandId,
      enabled: true,
      channelIds: [channel?.id as string],
      timezone: "UTC",
      startHour: 0,
      quietStartHour: 0,
      quietEndHour: 0,
      dailyRunLimit: 5,
    });
    if (withTopic)
      await db.insert(schema.topics).values({ orgId, brandId, title: "Topic", status: "approved" });
    return brandId;
  }

  it("records a skipped decision once for concurrent retries", async () => {
    const brandId = await brand(false);
    const jobId = randomUUID();
    expect(
      await Promise.all([
        service.trigger(boss, orgId, brandId, undefined, { jobId, startedAt: new Date() }),
        service.trigger(boss, orgId, brandId, undefined, { jobId, startedAt: new Date() }),
      ]),
    ).toEqual(["no_approved_topic", "no_approved_topic"]);
    const rows = await db
      .select()
      .from(schema.autopilotScanEvents)
      .where(eq(schema.autopilotScanEvents.brandId, brandId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scanJobId: jobId,
      status: "skipped",
      decision: "no_approved_topic",
      runId: null,
    });
    await expect(
      db.execute(
        sql`UPDATE autopilot_scan_events SET decision = 'provider_exception' WHERE id = ${rows[0]?.id}`,
      ),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint: "autopilot_scan_events_decision_check" },
    });
  });

  it("commits dispatch admission with the run and queue job, and a retry cannot dispatch twice", async () => {
    const brandId = await brand(true);
    const jobId = randomUUID();
    const scan = { jobId, startedAt: new Date() };
    expect(
      await Promise.all([
        service.trigger(boss, orgId, brandId, undefined, scan),
        service.trigger(boss, orgId, brandId, undefined, scan),
      ]),
    ).toEqual(["dispatched", "dispatched"]);
    const rows = await db
      .select()
      .from(schema.autopilotScanEvents)
      .where(eq(schema.autopilotScanEvents.brandId, brandId));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "dispatched", decision: "dispatched" });
    const dispatches = await db
      .select()
      .from(schema.autopilotDispatches)
      .where(eq(schema.autopilotDispatches.brandId, brandId));
    expect(dispatches).toHaveLength(1);
    expect(rows[0]?.runId).toBe(dispatches[0]?.runId);
    expect(
      await boss.findJobs("generate", { data: { runId: rows[0]?.runId, orgId } }),
    ).toHaveLength(1);
    await db
      .delete(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, rows[0]?.runId as string));
    const [retained] = await db
      .select()
      .from(schema.autopilotScanEvents)
      .where(eq(schema.autopilotScanEvents.id, rows[0]?.id as string));
    expect(retained).toMatchObject({ status: "dispatched", decision: "dispatched", runId: null });
    await db.delete(schema.brands).where(eq(schema.brands.id, brandId));
    expect(
      await db
        .select()
        .from(schema.autopilotScanEvents)
        .where(eq(schema.autopilotScanEvents.id, rows[0]?.id as string)),
    ).toHaveLength(0);
  });

  it("continues past a brand deleted between discovery and admission", async () => {
    const first = await brand(false);
    const second = await brand(false);
    const [deletedBrand, healthyBrand] = [first, second].sort();
    const original = service.trigger.bind(service);
    const spy = vi.spyOn(service, "trigger").mockImplementation(async (...args) => {
      if (args[2] === deletedBrand) {
        await db.delete(schema.brands).where(eq(schema.brands.id, deletedBrand));
      }
      return original(...args);
    });
    const jobId = randomUUID();
    try {
      await service.scan(boss, jobId);
    } finally {
      spy.mockRestore();
    }
    const surviving = await db
      .select()
      .from(schema.autopilotScanEvents)
      .where(eq(schema.autopilotScanEvents.scanJobId, jobId));
    expect(surviving.some((row) => row.brandId === healthyBrand)).toBe(true);
    expect(surviving.some((row) => row.brandId === deletedBrand)).toBe(false);
  });

  it("rolls back failed admission, records only a safe failure code, and continues scanning", async () => {
    const failedBrand = await brand(true);
    const healthyBrand = await brand(false);
    // The first generated dispatch is rejected while all subsequent brands are still checked.
    const realSend = boss.send.bind(boss);
    let rejected = false;
    boss.send = (async (...args: Parameters<PgBoss["send"]>) => {
      if (!rejected) {
        rejected = true;
        return null;
      }
      return realSend(...args);
    }) as PgBoss["send"];
    const jobId = randomUUID();
    try {
      await service.scan(boss, jobId);
    } finally {
      boss.send = realSend;
    }
    const failed = await db
      .select()
      .from(schema.autopilotScanEvents)
      .where(eq(schema.autopilotScanEvents.brandId, failedBrand));
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ status: "failed", decision: "worker_failed", runId: null });
    expect(
      await db
        .select()
        .from(schema.autopilotDispatches)
        .where(eq(schema.autopilotDispatches.brandId, failedBrand)),
    ).toHaveLength(0);
    const healthy = await db
      .select()
      .from(schema.autopilotScanEvents)
      .where(eq(schema.autopilotScanEvents.brandId, healthyBrand));
    expect(healthy).toHaveLength(1);
    expect(healthy[0]?.status).toBe("skipped");
    await service.scan(boss, jobId);
    expect(
      await db
        .select()
        .from(schema.autopilotScanEvents)
        .where(eq(schema.autopilotScanEvents.brandId, failedBrand)),
    ).toHaveLength(1);
    expect(
      await db
        .select()
        .from(schema.autopilotDispatches)
        .where(eq(schema.autopilotDispatches.brandId, failedBrand)),
    ).toHaveLength(0);
  });

  it("prunes at most 500 expired decisions per scan", async () => {
    const brandId = await brand(false);
    await db.insert(schema.autopilotScanEvents).values(
      Array.from({ length: 501 }, () => ({
        orgId,
        brandId,
        scanJobId: randomUUID(),
        status: "skipped" as const,
        decision: "no_approved_topic" as const,
        startedAt: new Date("2020-01-01"),
        finishedAt: new Date("2020-01-01"),
      })),
    );
    await service.pruneHistory();
    const count = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.autopilotScanEvents)
      .where(eq(schema.autopilotScanEvents.brandId, brandId));
    expect(count[0]?.count).toBe(1);
    await service.pruneHistory();
    const after = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.autopilotScanEvents)
      .where(eq(schema.autopilotScanEvents.brandId, brandId));
    expect(after[0]?.count).toBe(0);
  });
});
