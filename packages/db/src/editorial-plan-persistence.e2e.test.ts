import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PAID_GENERATION_CONSENT_VERSION } from "@pubrick/shared";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import {
  EditorialPlansPersistence,
  editorialPlanColumns,
  editorialPlanOccurrenceColumns,
  lockEditorialPlanParents,
  recordEditorialPlanDispatch,
} from "./editorial-plan-persistence.js";
import { runMigrations } from "./migrate.js";
import * as schema from "./schema/index.js";

const url = process.env.TEST_DATABASE_URL;
const clock = new Date("2026-10-01T00:00:00Z");
const consent = {
  allowPaidGeneration: true as const,
  consentVersion: PAID_GENERATION_CONSENT_VERSION,
};
const actor = "user_opaque-better-auth-identifier";
describe.skipIf(!url)("transactional weekly editorial persistence", () => {
  let connection: ReturnType<typeof createDb>;
  let store: EditorialPlansPersistence;
  const orgs: string[] = [];
  let upgradeId: string;
  beforeAll(async () => {
    connection = createDb(url as string);
    store = new EditorialPlansPersistence(connection.db);
    // Upgrade a populated pre-feature database, including an ordinary slot.
    const folder = await mkdtemp(path.join(tmpdir(), "weekly-plan-upgrade-"));
    try {
      const source = path.resolve("migrations");
      const journal = JSON.parse(
        await readFile(path.join(source, "meta/_journal.json"), "utf8"),
      ) as { entries: { tag: string }[] };
      journal.entries = journal.entries.filter(
        (entry) => entry.tag !== "0126_weekly_editorial_plans",
      );
      await mkdir(path.join(folder, "meta"));
      await writeFile(path.join(folder, "meta/_journal.json"), JSON.stringify(journal));
      for (const entry of journal.entries)
        await writeFile(
          path.join(folder, `${entry.tag}.sql`),
          await readFile(path.join(source, `${entry.tag}.sql`)),
        );
      await migrate(drizzle(connection.pool), { migrationsFolder: folder });
      const orgId = `weekly-upgrade-${randomUUID()}`;
      orgs.push(orgId);
      await connection.pool.query(
        "insert into organization(id,name,slug) values($1,'Upgrade',$1)",
        [orgId],
      );
      const brand = await connection.pool.query<{ id: string }>(
        "insert into brands(org_id,name) values($1,'Upgrade') returning id",
        [orgId],
      );
      const slot = await connection.pool.query<{ id: string }>(
        "insert into calendar_slots(org_id,brand_id,scheduled_at,brief,channel_ids) values($1,$2,'2026-10-01T09:00:00Z','Existing ordinary brief','[]') returning id",
        [orgId, brand.rows[0]?.id],
      );
      upgradeId = slot.rows[0]?.id ?? "";
      await runMigrations(url as string);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }, 60_000);
  afterAll(async () => {
    if (!connection) return;
    for (const orgId of orgs)
      await connection.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await connection.pool.end();
  });
  async function fixture() {
    const orgId = `weekly-${randomUUID()}`;
    orgs.push(orgId);
    await connection.db
      .insert(schema.organization)
      .values({ id: orgId, name: "Weekly", slug: orgId });
    const [brand] = await connection.db
      .insert(schema.brands)
      .values({ orgId, name: "Weekly" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("Missing brand");
    const [channel] = await connection.db
      .insert(schema.channels)
      .values({ orgId, brandId: brand.id, name: "Channel", platform: "vc_ru" })
      .returning({ id: schema.channels.id });
    if (!channel) throw new Error("Missing channel");
    const draft = {
      brandId: brand.id,
      name: "Weekly drafts",
      brief: "Original brief",
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      channelIds: [channel.id],
      localTime: "09:00",
      timezone: "UTC",
      startDate: "2026-10-01",
      endDate: "2026-10-14",
    };
    const plan = await store.create(orgId, draft, clock);
    return { orgId, brandId: brand.id, channelId: channel.id, draft, plan };
  }
  async function enabledFixture() {
    const f = await fixture();
    const plan = await store.enable(
      f.orgId,
      f.brandId,
      f.plan.id,
      { ...consent, expectedRevision: 1 },
      actor,
      clock,
      async () => {},
    );
    await store.materialize(f.orgId, f.brandId, plan.id, clock);
    return { ...f, plan };
  }
  async function occurrences(f: { orgId: string; brandId: string; plan: { id: string } }) {
    return connection.db
      .select(editorialPlanOccurrenceColumns)
      .from(schema.editorialPlanOccurrences)
      .where(
        and(
          eq(schema.editorialPlanOccurrences.orgId, f.orgId),
          eq(schema.editorialPlanOccurrences.brandId, f.brandId),
          eq(schema.editorialPlanOccurrences.planId, f.plan.id),
        ),
      )
      .orderBy(schema.editorialPlanOccurrences.localDate);
  }
  async function getPlan(f: { orgId: string; brandId: string; plan: { id: string } }) {
    const [plan] = await connection.db
      .select(editorialPlanColumns)
      .from(schema.editorialPlans)
      .where(
        and(
          eq(schema.editorialPlans.orgId, f.orgId),
          eq(schema.editorialPlans.brandId, f.brandId),
          eq(schema.editorialPlans.id, f.plan.id),
        ),
      );
    if (!plan) throw new Error("Missing plan");
    return plan;
  }
  const edit = (
    f: Awaited<ReturnType<typeof fixture>>,
    expectedRevision: number,
    brief = "Edited brief",
  ) => {
    const { brandId: _, ...fields } = f.draft;
    return { ...fields, brief, expectedRevision };
  };

  it("upgrades existing ordinary slots without rewriting their brief/time/attribution", async () => {
    const row = await connection.pool.query(
      "select brief, scheduled_at::text, recurring_occurrence_id from calendar_slots where id=$1",
      [upgradeId],
    );
    expect(row.rows[0]).toEqual({
      brief: "Existing ordinary brief",
      scheduled_at: "2026-10-01 09:00:00+00",
      recurring_occurrence_id: null,
    });
  });
  it("saves disabled, materializes nothing and validates scoped channels", async () => {
    const f = await fixture();
    expect(f.plan).toMatchObject({ enabled: false, revision: 1, consentVersion: null });
    expect(await store.materialize(f.orgId, f.brandId, f.plan.id, clock)).toMatchObject({
      createdCount: 0,
    });
    expect(await occurrences(f)).toEqual([]);
    const other = await fixture();
    await expect(
      store.create(f.orgId, { ...f.draft, channelIds: [other.channelId] }, clock),
    ).rejects.toMatchObject({ code: "channels_missing" });
  });
  it("serializes concurrent disabled creates at the five-plan bound", async () => {
    const f = await fixture();
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () => store.create(f.orgId, f.draft, clock)),
    );
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(4);
    expect(
      results
        .filter((row) => row.status === "rejected")
        .map((row) => row.status === "rejected" && row.reason.code),
    ).toEqual(["plan_limit", "plan_limit"]);
    const rows = await connection.db
      .select({ id: schema.editorialPlans.id })
      .from(schema.editorialPlans)
      .where(eq(schema.editorialPlans.brandId, f.brandId));
    expect(rows).toHaveLength(5);
  });
  it("atomic enable refuses concurrent replay/stale consent and rolls back failed enqueue", async () => {
    const f = await fixture();
    await expect(
      store.enable(
        f.orgId,
        f.brandId,
        f.plan.id,
        { ...consent, expectedRevision: 1 },
        actor,
        clock,
        async () => {
          throw new Error("queue unavailable");
        },
      ),
    ).rejects.toThrow("queue unavailable");
    expect(await getPlan(f)).toMatchObject({
      enabled: false,
      revision: 1,
      consentedRevision: null,
    });
    const results = await Promise.allSettled(
      [1, 2].map(() =>
        store.enable(
          f.orgId,
          f.brandId,
          f.plan.id,
          { ...consent, expectedRevision: 1 },
          actor,
          clock,
          async (tx, plan) => {
            const [visible] = await tx
              .select({ revision: schema.editorialPlans.revision })
              .from(schema.editorialPlans)
              .where(eq(schema.editorialPlans.id, plan.id));
            expect(visible?.revision).toBe(2);
          },
        ),
      ),
    );
    expect(results.filter((row) => row.status === "fulfilled")).toHaveLength(1);
    expect(results.find((row) => row.status === "rejected")).toMatchObject({
      reason: { code: "revision_conflict" },
    });
    await expect(
      store.enable(
        f.orgId,
        f.brandId,
        f.plan.id,
        { ...consent, expectedRevision: 2 },
        actor,
        clock,
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "already_enabled" });
    expect(await getPlan(f)).toMatchObject({
      revision: 2,
      consentedRevision: 2,
      consentingActorId: actor,
    });
  });
  it("checks authority inside the write transaction and refuses cross-tenant mutations", async () => {
    const f = await fixture();
    const revoked = new EditorialPlansPersistence(connection.db, async (orgId, tx, brandId) => {
      expect(orgId).toBe(f.orgId);
      expect(brandId).toBe(f.brandId);
      expect(
        await tx
          .select({ id: schema.organization.id })
          .from(schema.organization)
          .where(eq(schema.organization.id, orgId)),
      ).toHaveLength(1);
      return false;
    });
    await expect(
      revoked.enable(
        f.orgId,
        f.brandId,
        f.plan.id,
        { ...consent, expectedRevision: 1 },
        actor,
        clock,
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "authority_revoked" });
    const other = await fixture();
    await expect(
      store.pause(other.orgId, f.brandId, f.plan.id, { expectedRevision: 1 }, clock),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await getPlan(f)).toMatchObject({ revision: 1, enabled: false });
  });
  it("two materializers create exactly one identity and slot per local date", async () => {
    const f = await fixture();
    await store.enable(
      f.orgId,
      f.brandId,
      f.plan.id,
      { ...consent, expectedRevision: 1 },
      actor,
      clock,
      async () => {},
    );
    const results = await Promise.all([
      store.materialize(f.orgId, f.brandId, f.plan.id, clock),
      store.materialize(f.orgId, f.brandId, f.plan.id, clock),
    ]);
    expect(results.map((result) => result.createdCount).sort((a, b) => a - b)).toEqual([0, 14]);
    const rows = await occurrences(f);
    expect(rows).toHaveLength(14);
    expect(new Set(rows.map((row) => row.localDate)).size).toBe(14);
    expect(
      await connection.db
        .select({ id: schema.calendarSlots.id })
        .from(schema.calendarSlots)
        .where(eq(schema.calendarSlots.brandId, f.brandId)),
    ).toHaveLength(14);
    const before = rows.map(({ updatedAt: _, ...row }) => row);
    await store.materialize(f.orgId, f.brandId, f.plan.id, new Date("2026-10-01T12:00:00Z"));
    expect((await occurrences(f)).map(({ updatedAt: _, ...row }) => row)).toEqual(before);
  });
  it("pause/resume updates the same identities and preserves manual skips", async () => {
    const f = await enabledFixture();
    const initial = await occurrences(f);
    const skipped = initial[1];
    if (!skipped?.slotId) throw new Error("Missing slot");
    await store.skipSlot(f.orgId, f.brandId, skipped.slotId, clock);
    const paused = await store.pause(f.orgId, f.brandId, f.plan.id, { expectedRevision: 2 }, clock);
    expect(paused?.revision).toBe(3);
    expect(
      (await store.pause(f.orgId, f.brandId, f.plan.id, { expectedRevision: 3 }, clock))?.revision,
    ).toBe(3);
    expect((await occurrences(f)).filter((row) => row.state === "suspended")).toHaveLength(13);
    expect(
      await connection.db
        .select({ id: schema.calendarSlots.id })
        .from(schema.calendarSlots)
        .where(eq(schema.calendarSlots.brandId, f.brandId)),
    ).toHaveLength(0);
    await store.enable(
      f.orgId,
      f.brandId,
      f.plan.id,
      { ...consent, expectedRevision: 3 },
      actor,
      clock,
      async () => {},
    );
    expect(await store.materialize(f.orgId, f.brandId, f.plan.id, clock)).toMatchObject({
      createdCount: 0,
      replannedCount: 13,
    });
    const after = await occurrences(f);
    expect(after.map((row) => row.id)).toEqual(initial.map((row) => row.id));
    expect(after[1]).toMatchObject({ state: "skipped", reason: "manual_skip", planRevision: 2 });
    expect(after[0]?.slotId).not.toBe(initial[0]?.slotId);
  });
  it("replacement edit disables/clears consent, suspends removed weekdays and reuses matching future dates", async () => {
    const f = await enabledFixture();
    const before = await occurrences(f);
    await store.update(f.orgId, f.brandId, f.plan.id, { ...edit(f, 2), weekdays: [1] }, clock);
    expect(await getPlan(f)).toMatchObject({
      enabled: false,
      revision: 3,
      consentVersion: null,
      consentingActorId: null,
    });
    await expect(
      store.update(f.orgId, f.brandId, f.plan.id, edit(f, 2), clock),
    ).rejects.toMatchObject({ code: "revision_conflict" });
    await store.enable(
      f.orgId,
      f.brandId,
      f.plan.id,
      { ...consent, expectedRevision: 3 },
      actor,
      clock,
      async () => {},
    );
    expect(await store.materialize(f.orgId, f.brandId, f.plan.id, clock)).toMatchObject({
      createdCount: 0,
      replannedCount: 2,
    });
    const after = await occurrences(f);
    expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
    expect(
      after.filter((row) => row.state === "planned").map((row) => [row.brief, row.planRevision]),
    ).toEqual([
      ["Edited brief", 4],
      ["Edited brief", 4],
    ]);
    expect(after.filter((row) => row.state === "suspended")).toHaveLength(12);
  });
  it("explicit replan skips today's passed instant and never catches up historical days", async () => {
    const f = await enabledFixture();
    const initial = await occurrences(f);
    await store.pause(f.orgId, f.brandId, f.plan.id, { expectedRevision: 2 }, clock);
    const later = new Date("2026-10-02T12:00:00Z");
    await store.enable(
      f.orgId,
      f.brandId,
      f.plan.id,
      { ...consent, expectedRevision: 3 },
      actor,
      later,
      async () => {},
    );
    await store.materialize(f.orgId, f.brandId, f.plan.id, later);
    const after = await occurrences(f);
    expect(after[0]).toMatchObject({ id: initial[0]?.id, state: "suspended", planRevision: 2 });
    expect(after[1]).toMatchObject({
      id: initial[1]?.id,
      state: "skipped",
      reason: "generation_window_expired",
      planRevision: 4,
    });
  });
  it("removal retains terminal plan/date tombstones, frees plan quota and is idempotent", async () => {
    const f = await enabledFixture();
    const before = await occurrences(f);
    await store.remove(f.orgId, f.brandId, f.plan.id, { expectedRevision: 2 }, clock);
    expect(
      (await store.remove(f.orgId, f.brandId, f.plan.id, { expectedRevision: 3 }, clock))?.revision,
    ).toBe(3);
    expect((await occurrences(f)).map((row) => [row.id, row.state, row.reason])).toEqual(
      before.map((row) => [row.id, "cancelled", "plan_removed"]),
    );
    await expect(
      store.enable(
        f.orgId,
        f.brandId,
        f.plan.id,
        { ...consent, expectedRevision: 3 },
        actor,
        clock,
        async () => {},
      ),
    ).rejects.toMatchObject({ code: "removed" });
    await expect(
      store.update(f.orgId, f.brandId, f.plan.id, edit(f, 3), clock),
    ).rejects.toMatchObject({ code: "removed" });
    await expect(
      connection.pool.query("update editorial_plans set removed_at=null where id=$1", [f.plan.id]),
    ).rejects.toMatchObject({ code: "23514" });
    expect(await store.create(f.orgId, f.draft, clock)).toMatchObject({ enabled: false });
  });
  it("serializes concurrent materialization at retained capacity without partial batches", async () => {
    const f = await fixture();
    const second = await store.create(f.orgId, f.draft, clock);
    const early = new Date("2026-09-01T00:00:00Z");
    for (const plan of [f.plan, second])
      await store.enable(
        f.orgId,
        f.brandId,
        plan.id,
        { ...consent, expectedRevision: 1 },
        actor,
        early,
        async () => {},
      );
    await connection.pool.query(
      `insert into editorial_plan_occurrences(org_id,brand_id,plan_id,local_date,local_time,timezone,scheduled_at,offset_minutes,plan_revision,brief,channel_ids,state,reason)
      select $1,$2,$3,date '1990-01-01'+n,'09:00','UTC',timestamptz '1990-01-01 09:00:00+00'+n*interval '1 day',0,1,'Retained tombstone',$4::jsonb,'skipped','manual_skip' from generate_series(0,9985) n`,
      [f.orgId, f.brandId, f.plan.id, JSON.stringify([f.channelId])],
    );
    const results = await Promise.all(
      [f.plan, second].map((plan) => store.materialize(f.orgId, f.brandId, plan.id, clock)),
    );
    expect(results.map((row) => row.createdCount).sort((a, b) => a - b)).toEqual([0, 14]);
    expect(
      results.filter((row) => row.blockedReason === "retention_capacity_reached"),
    ).toHaveLength(1);
    expect(
      (
        await connection.pool.query(
          "select count(*)::int as total from editorial_plan_occurrences where brand_id=$1",
          [f.brandId],
        )
      ).rows[0]?.total,
    ).toBe(10000);
    expect(
      (
        await connection.pool.query(
          "select count(*)::int as total from calendar_slots where brand_id=$1",
          [f.brandId],
        )
      ).rows[0]?.total,
    ).toBe(14);
    await expect(store.create(f.orgId, f.draft, clock)).rejects.toMatchObject({
      code: "retention_capacity_reached",
    });
    await expect(
      store.update(f.orgId, f.brandId, f.plan.id, { ...edit(f, 2), endDate: "2026-10-15" }, clock),
    ).rejects.toMatchObject({ code: "retention_capacity_reached" });
    expect((await occurrences(f)).filter((row) => row.localDate < "2020-01-01")).toHaveLength(9986);
  });
  it("enforces composite ownership, unique date identity, closed state and null-instant rules", async () => {
    const f = await enabledFixture();
    const other = await fixture();
    const rows = await occurrences(f);
    const first = rows[0];
    if (!first) throw new Error("Missing occurrence");
    const insert = (
      orgId: string,
      brandId: string,
      planId: string,
      localDate: string,
      scheduledAt: Date | null,
      offset: number | null,
      state: string,
      reason: string | null,
    ) =>
      connection.pool.query(
        `insert into editorial_plan_occurrences(org_id,brand_id,plan_id,local_date,local_time,timezone,scheduled_at,offset_minutes,plan_revision,brief,channel_ids,state,reason) values($1,$2,$3,$4,'09:00','UTC',$5,$6,1,'Invalid fixture',$7::jsonb,$8,$9)`,
        [
          orgId,
          brandId,
          planId,
          localDate,
          scheduledAt,
          offset,
          JSON.stringify([f.channelId]),
          state,
          reason,
        ],
      );
    await expect(
      insert(other.orgId, other.brandId, f.plan.id, "2026-11-01", clock, 0, "planned", null),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      insert(f.orgId, other.brandId, f.plan.id, "2026-11-01", clock, 0, "planned", null),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      insert(f.orgId, f.brandId, f.plan.id, first.localDate, clock, 0, "planned", null),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      insert(f.orgId, f.brandId, f.plan.id, "2026-11-01", null, null, "skipped", null),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insert(f.orgId, f.brandId, f.plan.id, "2026-11-01", clock, 0, "unknown", null),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      connection.pool.query("update calendar_slots set recurring_occurrence_id=null where id=$1", [
        first.slotId,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      connection.pool.query(
        "update editorial_plan_occurrences set local_date='2026-11-01' where id=$1",
        [first.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      connection.pool.query(
        "update editorial_plan_occurrences set brief='Silent rewrite' where id=$1",
        [first.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await store.pause(f.orgId, f.brandId, f.plan.id, { expectedRevision: 2 }, clock);
    await expect(
      connection.pool.query(
        "insert into calendar_slots(org_id,brand_id,scheduled_at,brief,channel_ids,recurring_occurrence_id) values($1,$2,$3,'Wrong scope','[]',$4)",
        [other.orgId, other.brandId, clock, first.id],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("dispatch linkage rolls back enqueue failure and survives deletion/replay of run and slot", async () => {
    const f = await enabledFixture();
    const first = (await occurrences(f))[0];
    if (!first?.slotId) throw new Error("Missing slot");
    const slotId = first.slotId;
    let runId = "";
    const dispatch = async (fail: boolean) =>
      connection.db.transaction(async (tx) => {
        await lockEditorialPlanParents(f.orgId, tx, f.brandId);
        const [run] = await tx
          .insert(schema.pipelineRuns)
          .values({
            orgId: f.orgId,
            brandId: f.brandId,
            input: { kind: "brief", text: "Snapshot", channelIds: [f.channelId] },
          })
          .returning({ id: schema.pipelineRuns.id });
        if (!run) throw new Error("Missing run");
        runId = run.id;
        await recordEditorialPlanDispatch(
          f.orgId,
          tx,
          f.brandId,
          f.plan.id,
          first.id,
          slotId,
          run.id,
          clock,
        );
        if (fail) throw new Error("queue unavailable");
      });
    await expect(dispatch(true)).rejects.toThrow("queue unavailable");
    expect((await occurrences(f))[0]).toMatchObject({
      state: "planned",
      dispatchedAt: null,
      runId: null,
    });
    expect(
      (
        await connection.pool.query(
          "select count(*)::int as total from pipeline_runs where brand_id=$1",
          [f.brandId],
        )
      ).rows[0]?.total,
    ).toBe(0);
    await dispatch(false);
    await connection.db.delete(schema.pipelineRuns).where(eq(schema.pipelineRuns.id, runId));
    await connection.db.delete(schema.calendarSlots).where(eq(schema.calendarSlots.id, slotId));
    const snapshot = (await occurrences(f))[0];
    expect(snapshot).toMatchObject({
      state: "dispatched",
      runId,
      slotId,
      consentingActorId: actor,
      consentedRevision: 2,
    });
    await expect(
      connection.pool.query(
        "update editorial_plan_occurrences set dispatched_at=null,state='planned',run_id=null where id=$1",
        [first.id],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await store.pause(f.orgId, f.brandId, f.plan.id, { expectedRevision: 2 }, clock);
    await store.enable(
      f.orgId,
      f.brandId,
      f.plan.id,
      { ...consent, expectedRevision: 3 },
      actor,
      clock,
      async () => {},
    );
    await store.materialize(f.orgId, f.brandId, f.plan.id, clock);
    expect((await occurrences(f))[0]).toEqual(snapshot);
    await expect(
      connection.db.transaction(async (tx) => {
        await lockEditorialPlanParents(f.orgId, tx, f.brandId);
        await recordEditorialPlanDispatch(
          f.orgId,
          tx,
          f.brandId,
          f.plan.id,
          first.id,
          slotId,
          runId,
          clock,
        );
      }),
    ).rejects.toMatchObject({ code: "not_dispatchable" });
  });
  it("rolls back occurrence and slot insertion as one batch if a slot write fails", async () => {
    const f = await fixture();
    await store.update(f.orgId, f.brandId, f.plan.id, edit(f, 1, "Reject slot fixture"), clock);
    await store.enable(
      f.orgId,
      f.brandId,
      f.plan.id,
      { ...consent, expectedRevision: 2 },
      actor,
      clock,
      async () => {},
    );
    await connection.pool.query(
      `create function reject_weekly_test_slot() returns trigger language plpgsql as $$ begin if NEW.brief='Reject slot fixture' then raise exception 'synthetic slot failure'; end if; return NEW; end $$`,
    );
    await connection.pool.query(
      "create trigger reject_weekly_test_slot before insert on calendar_slots for each row execute function reject_weekly_test_slot()",
    );
    try {
      await expect(store.materialize(f.orgId, f.brandId, f.plan.id, clock)).rejects.toThrow();
      expect(await occurrences(f)).toEqual([]);
      expect(
        (
          await connection.pool.query(
            "select count(*)::int as total from calendar_slots where brand_id=$1",
            [f.brandId],
          )
        ).rows[0]?.total,
      ).toBe(0);
    } finally {
      await connection.pool.query("drop trigger reject_weekly_test_slot on calendar_slots");
      await connection.pool.query("drop function reject_weekly_test_slot()");
    }
  });
  it("persists a DST gap with its local identity, null instant and no slot", async () => {
    const f = await fixture();
    const gapClock = new Date("2026-03-07T00:00:00Z");
    await store.update(
      f.orgId,
      f.brandId,
      f.plan.id,
      {
        ...edit(f, 1),
        timezone: "America/New_York",
        localTime: "02:30",
        startDate: "2026-03-08",
        endDate: "2026-03-08",
      },
      gapClock,
    );
    await store.enable(
      f.orgId,
      f.brandId,
      f.plan.id,
      { ...consent, expectedRevision: 2 },
      actor,
      gapClock,
      async () => {},
    );
    expect(await store.materialize(f.orgId, f.brandId, f.plan.id, gapClock)).toMatchObject({
      createdCount: 1,
    });
    expect(await occurrences(f)).toMatchObject([
      {
        localDate: "2026-03-08",
        localTime: "02:30",
        timezone: "America/New_York",
        state: "skipped",
        reason: "dst_gap",
        scheduledAt: null,
        offsetMinutes: null,
        slotId: null,
      },
    ]);
    expect(
      (
        await connection.pool.query(
          "select count(*)::int as total from calendar_slots where brand_id=$1",
          [f.brandId],
        )
      ).rows[0]?.total,
    ).toBe(0);
    expect(await store.materialize(f.orgId, f.brandId, f.plan.id, gapClock)).toMatchObject({
      createdCount: 0,
      replannedCount: 0,
    });
  });
  it("refuses a run owned by another brand before durable dispatch attribution", async () => {
    const f = await enabledFixture();
    const other = await fixture();
    const first = (await occurrences(f))[0];
    if (!first?.slotId) throw new Error("Missing slot");
    const slotId = first.slotId;
    const [foreignRun] = await connection.db
      .insert(schema.pipelineRuns)
      .values({
        orgId: other.orgId,
        brandId: other.brandId,
        input: { kind: "brief", text: "Foreign run", channelIds: [other.channelId] },
      })
      .returning({ id: schema.pipelineRuns.id });
    if (!foreignRun) throw new Error("Missing run");
    await expect(
      connection.db.transaction(async (tx) => {
        await lockEditorialPlanParents(f.orgId, tx, f.brandId);
        await recordEditorialPlanDispatch(
          f.orgId,
          tx,
          f.brandId,
          f.plan.id,
          first.id,
          slotId,
          foreignRun.id,
          clock,
        );
      }),
    ).rejects.toMatchObject({ code: "not_dispatchable" });
    expect((await occurrences(f))[0]).toMatchObject({
      state: "planned",
      dispatchedAt: null,
      runId: null,
    });
    expect(
      (await connection.pool.query("select run_id from calendar_slots where id=$1", [slotId]))
        .rows[0]?.run_id,
    ).toBe(null);
  });
  it("parent deletion waits for materialization and cascades recurring links without a lock cycle", async () => {
    const f = await fixture();
    await store.enable(
      f.orgId,
      f.brandId,
      f.plan.id,
      { ...consent, expectedRevision: 1 },
      actor,
      clock,
      async () => {},
    );
    const client = await connection.pool.connect();
    try {
      await client.query("begin");
      await client.query("set local lock_timeout='2s'");
      await client.query("select id from brands where org_id=$1 and id=$2 for no key update", [
        f.orgId,
        f.brandId,
      ]);
      const materializing = store.materialize(f.orgId, f.brandId, f.plan.id, clock);
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt++) {
        const blocked = await connection.pool.query(
          "select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%from \"brands\"%') as waiting",
        );
        waiting = blocked.rows[0]?.waiting === true;
      }
      expect(waiting).toBe(true);
      // Prove the writer is waiting on this parent before allowing the cascade.
      await client.query("delete from brands where org_id=$1 and id=$2", [f.orgId, f.brandId]);
      await client.query("commit");
      await expect(materializing).rejects.toMatchObject({ code: "not_found" });
      expect(
        (
          await connection.pool.query(
            "select count(*)::int as total from editorial_plan_occurrences where brand_id=$1",
            [f.brandId],
          )
        ).rows[0]?.total,
      ).toBe(0);
      expect(
        (
          await connection.pool.query(
            "select count(*)::int as total from calendar_slots where brand_id=$1",
            [f.brandId],
          )
        ).rows[0]?.total,
      ).toBe(0);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
