import { randomUUID } from "node:crypto";
import { encryptJson, PAID_GENERATION_CONSENT_VERSION } from "@pubrick/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const early = new Date("2026-10-01T08:50:00Z");
const due = new Date("2026-10-01T09:00:00Z");
describe.skipIf(!url)("recurring calendar paid dispatch", () => {
  let connection: ReturnType<typeof import("@pubrick/db").createDb>;
  let schema: typeof import("@pubrick/db").schema;
  let store: InstanceType<typeof import("@pubrick/db").EditorialPlansPersistence>;
  let service: InstanceType<typeof import("./calendar.service").CalendarService>;
  let boss: InstanceType<typeof import("pg-boss").PgBoss>;
  const orgs: string[] = [];
  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    const pkg = await import("@pubrick/db");
    schema = pkg.schema;
    connection = pkg.createDb(url as string);
    store = new pkg.EditorialPlansPersistence(connection.db);
    boss = new (await import("pg-boss")).PgBoss({
      connectionString: url as string,
      supervise: false,
      schedule: false,
    });
    boss.on("error", (error: Error) => console.error("recurring test", error));
    await boss.start();
    await boss.createQueue("generate");
    service = new (await import("./calendar.service")).CalendarService();
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    for (const id of orgs)
      await connection.db.delete(schema.organization).where(eq(schema.organization.id, id));
    await boss?.stop({ graceful: false, timeout: 5000 });
    await connection?.pool.end();
  });
  async function fixture(configured = true, localTime = "09:00") {
    const orgId = `weekly-dispatch-${randomUUID()}`;
    orgs.push(orgId);
    await connection.db
      .insert(schema.organization)
      .values({ id: orgId, name: "Synthetic", slug: orgId });
    const [brand] = await connection.db
      .insert(schema.brands)
      .values({ orgId, name: "Synthetic" })
      .returning();
    if (!brand) throw new Error("Missing brand");
    const [channel] = await connection.db
      .insert(schema.channels)
      .values({ orgId, brandId: brand.id, name: "Synthetic", platform: "vc_ru" })
      .returning();
    if (!channel) throw new Error("Missing channel");
    if (configured) {
      await connection.db.insert(schema.aiCredentials).values({
        orgId,
        provider: "openai_compatible",
        revision: 4,
        credentialsEncrypted: encryptJson(
          { apiKey: "synthetic-never-sent" },
          process.env.APP_ENCRYPTION_KEY as string,
        ),
      });
      await connection.db
        .insert(schema.aiTextSettings)
        .values({ orgId, provider: "openai_compatible", model: "gpt-synthetic", revision: 3 });
    }
    const draft = {
      brandId: brand.id,
      name: "Weekly",
      brief: "Immutable useful brief",
      channelIds: [channel.id],
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      localTime,
      timezone: "UTC",
      startDate: "2026-10-01",
      endDate: "2026-10-14",
    };
    const plan = await store.create(orgId, draft, early);
    await store.enable(
      orgId,
      brand.id,
      plan.id,
      {
        expectedRevision: 1,
        allowPaidGeneration: true,
        consentVersion: PAID_GENERATION_CONSENT_VERSION,
      },
      "opaque_actor",
      early,
      async () => {},
    );
    await store.materialize(orgId, brand.id, plan.id, early);
    const rows = await connection.db
      .select()
      .from(schema.editorialPlanOccurrences)
      .where(eq(schema.editorialPlanOccurrences.planId, plan.id));
    const occurrence = rows.find((row) => row.localDate === "2026-10-01");
    if (!occurrence?.slotId) throw new Error("Missing occurrence");
    return {
      orgId,
      brandId: brand.id,
      channelId: channel.id,
      planId: plan.id,
      occurrenceId: occurrence.id,
      slotId: occurrence.slotId,
      draft,
    };
  }
  async function occurrence(id: string) {
    const [row] = await connection.db
      .select()
      .from(schema.editorialPlanOccurrences)
      .where(eq(schema.editorialPlanOccurrences.id, id));
    return row;
  }
  async function slot(id: string) {
    const [row] = await connection.db
      .select()
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.id, id));
    return row;
  }
  it("pins paid selection and queues exactly once with immutable brief and no images", async () => {
    const f = await fixture();
    await service.trigger(boss, f.orgId, f.slotId, () => due);
    await service.trigger(boss, f.orgId, f.slotId, () => due);
    const row = await occurrence(f.occurrenceId);
    expect(row?.state).toBe("dispatched");
    expect(row?.dispatchedAt).toEqual(due);
    const [run] = await connection.db
      .select()
      .from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, row?.runId as string));
    expect(run?.input).toEqual({ kind: "brief", text: f.draft.brief, channelIds: [f.channelId] });
    expect(run?.textSelection).toMatchObject({
      provider: "openai_compatible",
      modelId: "gpt-synthetic",
      settingsRevision: 3,
      credentialRevision: 4,
    });
    expect(await boss.findJobs("generate", { data: { orgId: f.orgId } })).toHaveLength(1);
  });
  it("rolls back run and irreversible marker when durable enqueue fails", async () => {
    const f = await fixture();
    const mocked = vi
      .spyOn(boss, "send")
      .mockRejectedValueOnce(new Error("synthetic enqueue failure"));
    await expect(service.trigger(boss, f.orgId, f.slotId, () => due)).rejects.toThrow(
      "synthetic enqueue failure",
    );
    mocked.mockRestore();
    expect(await occurrence(f.occurrenceId)).toMatchObject({
      state: "planned",
      runId: null,
      dispatchedAt: null,
    });
    expect((await slot(f.slotId))?.runId).toBeNull();
    expect(
      await connection.db
        .select()
        .from(schema.pipelineRuns)
        .where(eq(schema.pipelineRuns.orgId, f.orgId)),
    ).toEqual([]);
  });
  it("settles missing configuration and closes expired identities without catchup", async () => {
    const f = await fixture(false);
    await service.trigger(boss, f.orgId, f.slotId, () => due);
    expect(await occurrence(f.occurrenceId)).toMatchObject({
      state: "planned",
      reason: "provider_not_configured",
      runId: null,
    });
    await service.trigger(boss, f.orgId, f.slotId, () => new Date("2026-10-01T10:00:01Z"));
    expect(await occurrence(f.occurrenceId)).toMatchObject({
      state: "skipped",
      reason: "generation_window_expired",
      runId: null,
    });
    expect(await slot(f.slotId)).toBeUndefined();
  });
  it("evaluates the current clock after an actual parent lock wait", async () => {
    const f = await fixture();
    let current = new Date("2026-10-01T09:30:00Z");
    const client = await connection.pool.connect();
    await client.query("begin");
    await client.query("select id from brands where id=$1 for update", [f.brandId]);
    const trigger = service.trigger(boss, f.orgId, f.slotId, () => current);
    let waiting = false;
    try {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const result = await connection.pool.query<{ waiting: boolean }>(
          `select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%from "brands"%' and query like '%for key share%') as waiting`,
        );
        if (result.rows[0]?.waiting) {
          waiting = true;
          break;
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(waiting).toBe(true);
      current = new Date("2026-10-01T10:00:01Z");
      await client.query("commit");
      await trigger;
    } finally {
      await client.query("rollback");
      client.release();
    }
    expect(await occurrence(f.occurrenceId)).toMatchObject({
      state: "skipped",
      reason: "generation_window_expired",
      runId: null,
    });
  });

  it("accepts the exact one-hour boundary and rejects a later identity", async () => {
    const allowed = await fixture();
    await service.trigger(
      boss,
      allowed.orgId,
      allowed.slotId,
      () => new Date("2026-10-01T10:00:00Z"),
    );
    expect((await occurrence(allowed.occurrenceId))?.state).toBe("dispatched");
    const expired = await fixture();
    await service.trigger(
      boss,
      expired.orgId,
      expired.slotId,
      () => new Date("2026-10-01T10:00:00.001Z"),
    );
    expect(await occurrence(expired.occurrenceId)).toMatchObject({
      state: "skipped",
      reason: "generation_window_expired",
    });
  });
  it("closes expired quota refusals and never resurrects them after admission recovers", async () => {
    const f = await fixture();
    const admission = await import("../hosted-job-admission");
    const refusal = vi
      .spyOn(admission, "admitHostedJob")
      .mockResolvedValue("subscription_required");
    try {
      await service.trigger(boss, f.orgId, f.slotId, () => new Date("2026-10-01T10:00:01Z"));
    } finally {
      refusal.mockRestore();
    }
    await service.trigger(boss, f.orgId, f.slotId, () => new Date("2026-10-01T10:00:02Z"));
    expect(await occurrence(f.occurrenceId)).toMatchObject({
      state: "skipped",
      reason: "generation_window_expired",
      runId: null,
    });
    expect(await boss.findJobs("generate", { data: { orgId: f.orgId } })).toEqual([]);
  });
  it("settles configuration failure thrown before child locks and resumes only within the window", async () => {
    const f = await fixture();
    await connection.db.delete(schema.aiCredentials).where(eq(schema.aiCredentials.orgId, f.orgId));
    await service.trigger(boss, f.orgId, f.slotId, () => due);
    expect(await occurrence(f.occurrenceId)).toMatchObject({
      state: "planned",
      reason: "provider_not_configured",
    });
    await connection.db.insert(schema.aiCredentials).values({
      orgId: f.orgId,
      provider: "openai_compatible",
      revision: 5,
      credentialsEncrypted: encryptJson(
        { apiKey: "synthetic-repaired" },
        process.env.APP_ENCRYPTION_KEY as string,
      ),
    });
    await service.trigger(boss, f.orgId, f.slotId, () => new Date("2026-10-01T09:06:00Z"));
    expect(await occurrence(f.occurrenceId)).toMatchObject({
      state: "dispatched",
      reason: null,
      brief: f.draft.brief,
      channelIds: [f.channelId],
    });
    const expired = await fixture();
    await connection.db
      .delete(schema.aiCredentials)
      .where(eq(schema.aiCredentials.orgId, expired.orgId));
    await service.trigger(
      boss,
      expired.orgId,
      expired.slotId,
      () => new Date("2026-10-01T10:00:01Z"),
    );
    expect(await occurrence(expired.occurrenceId)).toMatchObject({
      state: "skipped",
      reason: "generation_window_expired",
    });
  });

  it("materializes redelivered jobs idempotently and never dispatches paused or removed plans", async () => {
    const f = await fixture();
    const planner = new (
      await import("./editorial-plan-planner.service")
    ).EditorialPlanPlannerService();
    const payload = { orgId: f.orgId, brandId: f.brandId, planId: f.planId };
    await planner.handle(payload, early);
    await planner.handle(payload, early);
    expect(
      await connection.db
        .select()
        .from(schema.editorialPlanOccurrences)
        .where(eq(schema.editorialPlanOccurrences.planId, f.planId)),
    ).toHaveLength(14);
    await store.pause(f.orgId, f.brandId, f.planId, { expectedRevision: 2 }, due);
    await planner.handle(payload, due);
    await service.trigger(boss, f.orgId, f.slotId, () => due);
    expect(await occurrence(f.occurrenceId)).toMatchObject({
      state: "suspended",
      runId: null,
      dispatchedAt: null,
    });
    await store.remove(f.orgId, f.brandId, f.planId, { expectedRevision: 3 }, due);
    await planner.handle(payload, due);
    await service.trigger(boss, f.orgId, f.slotId, () => due);
    expect(await occurrence(f.occurrenceId)).toMatchObject({
      state: "cancelled",
      runId: null,
      dispatchedAt: null,
    });
    expect(await boss.findJobs("generate", { data: { orgId: f.orgId } })).toEqual([]);
  });

  it("serializes dispatch and pause under measured occurrence and plan waits", async () => {
    const f = await fixture();
    const client = await connection.pool.connect();
    await client.query("begin");
    await client.query("select id from editorial_plan_occurrences where id=$1 for update", [
      f.occurrenceId,
    ]);
    const dispatch = service.trigger(boss, f.orgId, f.slotId, () => due);
    async function waiting(table: string) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const rows = await connection.pool.query<{ waiting: boolean }>(
          `select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like $1 and query like '%for update%') as waiting`,
          [`%from "${table}"%`],
        );
        if (rows.rows[0]?.waiting) return true;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return false;
    }
    try {
      expect(await waiting("editorial_plan_occurrences")).toBe(true);
      const pause = store.pause(f.orgId, f.brandId, f.planId, { expectedRevision: 2 }, due);
      expect(await waiting("editorial_plans")).toBe(true);
      await client.query("commit");
      await dispatch;
      await pause;
    } finally {
      await client.query("rollback");
      client.release();
    }
    expect(await occurrence(f.occurrenceId)).toMatchObject({
      state: "dispatched",
      dispatchedAt: due,
    });
    expect(await boss.findJobs("generate", { data: { orgId: f.orgId } })).toHaveLength(1);
    const [plan] = await connection.db
      .select()
      .from(schema.editorialPlans)
      .where(eq(schema.editorialPlans.id, f.planId));
    expect(plan).toMatchObject({ enabled: false, revision: 3 });
  });
  it("defers 100 quota refusals so the next bounded scan reaches a healthy tenant", async () => {
    for (const id of orgs.splice(0))
      await connection.db.delete(schema.organization).where(eq(schema.organization.id, id));
    const blocked = await fixture();
    const healthy = await fixture(true, "09:01");
    const [templatePlan] = await connection.db
      .select()
      .from(schema.editorialPlans)
      .where(eq(schema.editorialPlans.id, blocked.planId));
    const templateOccurrence = await occurrence(blocked.occurrenceId);
    if (!templatePlan || !templateOccurrence) throw new Error("Missing template");
    // Native synthetic rows have the exact consent/snapshot of the materialized identity.
    await connection.db.transaction(async (tx) => {
      for (let i = 1; i < 100; i++) {
        const [brand] = await tx
          .insert(schema.brands)
          .values({ orgId: blocked.orgId, name: `Synthetic ${i}` })
          .returning();
        if (!brand) throw new Error("Missing brand");
        const [channel] = await tx
          .insert(schema.channels)
          .values({ orgId: blocked.orgId, brandId: brand.id, name: "Synthetic", platform: "vc_ru" })
          .returning();
        if (!channel) throw new Error("Missing channel");
        const channelIds = [channel.id];
        const planId = randomUUID(),
          occurrenceId = randomUUID(),
          slotId = randomUUID();
        await tx
          .insert(schema.editorialPlans)
          .values({ ...templatePlan, channelIds, id: planId, brandId: brand.id });
        await tx.insert(schema.editorialPlanOccurrences).values({
          ...templateOccurrence,
          channelIds,
          id: occurrenceId,
          brandId: brand.id,
          planId,
          slotId: null,
        });
        await tx.insert(schema.calendarSlots).values({
          id: slotId,
          orgId: blocked.orgId,
          brandId: brand.id,
          recurringOccurrenceId: occurrenceId,
          scheduledAt: due,
          brief: templateOccurrence.brief,
          channelIds,
        });
        await tx
          .update(schema.editorialPlanOccurrences)
          .set({ slotId })
          .where(eq(schema.editorialPlanOccurrences.id, occurrenceId));
      }
    });
    const admission = await import("../hosted-job-admission");
    const refusal = vi
      .spyOn(admission, "admitHostedJob")
      .mockImplementation(async (_tx, orgId) =>
        orgId === blocked.orgId ? "subscription_required" : null,
      );
    try {
      const clock = () => new Date("2026-10-01T09:30:00Z");
      await service.scan(boss, clock);
      expect((await occurrence(healthy.occurrenceId))?.state).toBe("planned");
      const retries = await connection.pool.query<{ count: string }>(
        "select count(*) from calendar_slots where org_id=$1 and scheduled_at=$2 and retry_after=$3 and run_id is null",
        [blocked.orgId, due, new Date("2026-10-01T09:35:00Z")],
      );
      await service.scan(boss, clock);
      expect((await occurrence(healthy.occurrenceId))?.state).toBe("dispatched");
      expect(Number(retries.rows[0]?.count)).toBe(100);
      expect(await boss.findJobs("generate", { data: { orgId: blocked.orgId } })).toEqual([]);
    } finally {
      refusal.mockRestore();
    }
  }, 60_000);
});
