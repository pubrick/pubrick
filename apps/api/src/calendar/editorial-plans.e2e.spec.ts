import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import {
  editorialPlanListSchema,
  editorialPlanOccurrencesPageSchema,
  editorialPlanPreviewResultSchema,
  editorialPlanRemoveResultSchema,
  editorialPlanSummarySchema,
  PAID_GENERATION_CONSENT_VERSION,
} from "@pubrick/shared";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("recurring editorial session API", () => {
  let app: INestApplication;
  let connection: ReturnType<typeof createDb>;
  const orgIds: string[] = [];
  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    connection = createDb(url as string);
    const { AppModule } = await import("../app.module");
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  });
  afterAll(async () => {
    for (const orgId of orgIds)
      await connection.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    await app?.close();
    await connection?.pool.end();
  });
  async function account(verified = true) {
    const client = request.agent(app.getHttpServer());
    const stamp = randomUUID();
    const signup = await client
      .post("/api/auth/sign-up/email")
      .send({ email: `${stamp}@example.test`, password: "password1234", name: "Synthetic editor" })
      .expect(200);
    const userId = signup.body.user.id as string;
    await connection.db
      .update(schema.user)
      .set({ emailVerified: verified })
      .where(eq(schema.user.id, userId));
    return { client, userId };
  }
  async function fixture(verified = true) {
    const actor = await account(verified);
    const stamp = randomUUID();
    const organization = await actor.client
      .post("/api/auth/organization/create")
      .send({ name: "Weekly", slug: `weekly-${stamp}` })
      .expect(200);
    const orgId = organization.body.id as string;
    orgIds.push(orgId);
    await actor.client
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    const brand = await actor.client.post("/api/brands").send({ name: "Weekly" }).expect(201);
    const brandId = brand.body.id as string;
    const channel = await actor.client
      .post("/api/channels")
      .send({ brandId, platform: "vc_ru", name: "Synthetic channel" })
      .expect(201);
    const channelId = channel.body.id as string;
    const from = new Date();
    const to = new Date(from.getTime() + 13 * 86400_000);
    const draft = {
      brandId,
      name: "Weekly drafts",
      brief: "Write a useful social post",
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      channelIds: [channelId],
      localTime: "23:59",
      timezone: "UTC",
      startDate: from.toISOString().slice(0, 10),
      endDate: to.toISOString().slice(0, 10),
    };
    return { ...actor, orgId, brandId, channelId, draft };
  }
  const endpoint = (brandId: string, id = "") =>
    `/api/calendar/editorial-plans${id ? `/${id}` : ""}?brandId=${brandId}`;
  async function plan(f: Awaited<ReturnType<typeof fixture>>) {
    const result = await f.client.post("/api/calendar/editorial-plans").send(f.draft).expect(201);
    expect(editorialPlanSummarySchema.parse(result.body)).toEqual(result.body);
    return result.body as ReturnType<typeof editorialPlanSummarySchema.parse>;
  }

  it("allows an unverified self-hosted editor session under the configured identity policy", async () => {
    const f = await fixture(false);
    const [user] = await connection.db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, f.userId));
    expect(user?.emailVerified).toBe(false);
    await f.client.get(`/api/calendar/editorial-plans?brandId=${f.brandId}`).expect(200);
    const created = await f.client.post("/api/calendar/editorial-plans").send(f.draft).expect(201);
    await f.client
      .post(`/api/calendar/editorial-plans/${created.body.id}/enable?brandId=${f.brandId}`)
      .send({
        expectedRevision: 1,
        allowPaidGeneration: true,
        consentVersion: PAID_GENERATION_CONSENT_VERSION,
      })
      .expect(201);
  });

  it("refuses an unverified session when the canonical instance identity policy is hosted", async () => {
    const f = await fixture(false);
    const { identity } = await import("../env");
    const prior = identity.hosted;
    try {
      identity.hosted = true;
      const response = await f.client
        .get(`/api/calendar/editorial-plans?brandId=${f.brandId}`)
        .expect(403);
      expect(response.body.code).toBe("editorial_plan_authority_revoked");
      await f.client.post("/api/calendar/editorial-plans").send(f.draft).expect(403);
    } finally {
      identity.hosted = prior;
    }
  });
  it("round trips disabled save, free preview, list, enable, revision conflict, pause and removal", async () => {
    const f = await fixture();
    const saved = await plan(f);
    expect(saved).toMatchObject({
      enabled: false,
      revision: 1,
      consentVersion: null,
      consentingActorId: null,
      occurrences: [],
    });
    const { brandId: _, name: __, brief: ___, channelIds: ____, ...schedule } = f.draft;
    const preview = await f.client
      .post(`/api/calendar/editorial-plans/preview?brandId=${f.brandId}`)
      .send(schedule)
      .expect(201);
    expect(editorialPlanPreviewResultSchema.parse(preview.body)).toEqual(preview.body);
    expect(preview.body.occurrences.length).toBeLessThanOrEqual(14);
    expect(
      (
        await connection.pool.query(
          "select count(*)::int as total from pipeline_runs where org_id=$1",
          [f.orgId],
        )
      ).rows[0]?.total,
    ).toBe(0);
    const list = await f.client.get(endpoint(f.brandId)).expect(200);
    expect(editorialPlanListSchema.parse(list.body)).toEqual(list.body);
    const enabled = await f.client
      .post(`/api/calendar/editorial-plans/${saved.id}/enable?brandId=${f.brandId}`)
      .send({
        expectedRevision: 1,
        allowPaidGeneration: true,
        consentVersion: PAID_GENERATION_CONSENT_VERSION,
      })
      .expect(201);
    expect(editorialPlanSummarySchema.parse(enabled.body)).toEqual(enabled.body);
    expect(enabled.body).toMatchObject({
      enabled: true,
      revision: 2,
      consentedRevision: 2,
      consentingActorId: f.userId,
    });
    expect(
      (
        await connection.pool.query(
          "select count(*)::int as total from pgboss.job where name='editorial-plan-materialize' and data->>'planId'=$1",
          [saved.id],
        )
      ).rows[0]?.total,
    ).toBe(1);
    const stale = await f.client
      .post(`/api/calendar/editorial-plans/${saved.id}/pause?brandId=${f.brandId}`)
      .send({ expectedRevision: 1 })
      .expect(409);
    expect(stale.body.code).toBe("editorial_plan_revision_conflict");
    const paused = await f.client
      .post(`/api/calendar/editorial-plans/${saved.id}/pause?brandId=${f.brandId}`)
      .send({ expectedRevision: 2 })
      .expect(201);
    expect(editorialPlanSummarySchema.parse(paused.body)).toEqual(paused.body);
    const removed = await f.client
      .delete(endpoint(f.brandId, saved.id))
      .send({ expectedRevision: 3 })
      .expect(200);
    expect(editorialPlanRemoveResultSchema.parse(removed.body)).toEqual(removed.body);
    expect((await f.client.get(endpoint(f.brandId)).expect(200)).body).toEqual([]);
    expect(
      (
        await f.client
          .get(`/api/calendar/editorial-plans/${saved.id}/occurrences?brandId=${f.brandId}`)
          .expect(200)
      ).body,
    ).toEqual({ rows: [], nextCursor: null });
  });
  it("refuses invalid history query, semantic schedule, implicit enable and foreign plan IDs", async () => {
    const f = await fixture();
    const saved = await plan(f);
    for (const query of ["limit=101", "limit=nope", "cursor=wrong"]) {
      const result = await f.client
        .get(`/api/calendar/editorial-plans/${saved.id}/occurrences?brandId=${f.brandId}&${query}`)
        .expect(400);
      expect(result.body.code).toBe("invalid_request");
    }
    const invalid = await f.client
      .post("/api/calendar/editorial-plans")
      .send({ ...f.draft, timezone: "+03:00" })
      .expect(400);
    expect(invalid.body.code).toBe("invalid_request");
    await f.client
      .post("/api/calendar/editorial-plans")
      .send({ ...f.draft, enabled: true })
      .expect(400);
    await f.client
      .post(`/api/calendar/editorial-plans/${saved.id}/enable?brandId=${f.brandId}`)
      .send({ expectedRevision: 1 })
      .expect(400);
    const other = await fixture();
    const foreign = await plan(other);
    const refused = await f.client
      .patch(endpoint(f.brandId, foreign.id))
      .send({ ...f.draft, brandId: undefined, expectedRevision: 1 })
      .expect(404);
    expect(refused.body.code).toBe("editorial_plan_not_found");
  });
  it("shows recurring slot attribution, refuses direct edits and permanently skips explicit deletion", async () => {
    const f = await fixture();
    const saved = await plan(f);
    await f.client
      .post(`/api/calendar/editorial-plans/${saved.id}/enable?brandId=${f.brandId}`)
      .send({
        expectedRevision: 1,
        allowPaidGeneration: true,
        consentVersion: PAID_GENERATION_CONSENT_VERSION,
      })
      .expect(201);
    const { EditorialPlansPersistence } = await import("@pubrick/db");
    const persistence = new EditorialPlansPersistence(connection.db);
    await persistence.materialize(f.orgId, f.brandId, saved.id, new Date());
    const [slot] = await connection.db
      .select({ id: schema.calendarSlots.id })
      .from(schema.calendarSlots)
      .where(eq(schema.calendarSlots.brandId, f.brandId))
      .limit(1);
    if (!slot) throw new Error("Missing slot");
    const calendar = await f.client
      .get(
        `/api/calendar/slots?brandId=${f.brandId}&from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 14 * 86400_000).toISOString())}`,
      )
      .expect(200);
    expect(calendar.body.find((row: { id: string }) => row.id === slot.id)).toMatchObject({
      recurringPlanId: saved.id,
      recurringPlanName: f.draft.name,
      recurringOccurrenceState: "planned",
    });
    const refusal = await f.client
      .patch(`/api/calendar/slots/${slot.id}?brandId=${f.brandId}`)
      .send({ brief: "Do not rewrite" })
      .expect(409);
    expect(refusal.body.code).toBe("calendar_recurring_slot");
    await f.client.delete(`/api/calendar/slots/${slot.id}?brandId=${f.brandId}`).expect(200);
    await persistence.materialize(f.orgId, f.brandId, saved.id, new Date());
    const history = await f.client
      .get(`/api/calendar/editorial-plans/${saved.id}/occurrences?brandId=${f.brandId}`)
      .expect(200);
    expect(editorialPlanOccurrencesPageSchema.parse(history.body)).toEqual(history.body);
    expect(
      history.body.rows.find((row: { slotId: string }) => row.slotId === slot.id),
    ).toMatchObject({ state: "skipped", reason: "manual_skip" });
    expect(
      (
        await connection.pool.query(
          "select count(*)::int as total from calendar_slots where id=$1",
          [slot.id],
        )
      ).rows[0]?.total,
    ).toBe(0);
  });
  it("refuses author mutations and API-key authority while preserving ordinary scoped reads", async () => {
    const f = await fixture();
    const saved = await plan(f);
    const author = await account();
    const memberId = `member-${randomUUID()}`;
    await connection.db
      .insert(schema.member)
      .values({ id: memberId, organizationId: f.orgId, userId: author.userId, role: "author" });
    await connection.db
      .insert(schema.brandAccess)
      .values({ orgId: f.orgId, brandId: f.brandId, memberId });
    await author.client
      .post("/api/auth/organization/set-active")
      .send({ organizationId: f.orgId })
      .expect(200);
    await author.client.get(endpoint(f.brandId)).expect(200);
    await author.client.post("/api/calendar/editorial-plans").send(f.draft).expect(403);
    await author.client
      .post(`/api/calendar/editorial-plans/${saved.id}/enable?brandId=${f.brandId}`)
      .send({
        expectedRevision: 1,
        allowPaidGeneration: true,
        consentVersion: PAID_GENERATION_CONSENT_VERSION,
      })
      .expect(403);
    const { ApiKeysRepository } = await import("../public-api/api-keys.repository");
    const key = await app
      .get(ApiKeysRepository)
      .create(f.orgId, f.userId, { name: "Synthetic generation key", scope: "generation:create" });
    const external = await request(app.getHttpServer())
      .post("/api/calendar/editorial-plans")
      .set("Authorization", `Bearer ${key.key}`)
      .send(f.draft);
    expect([401, 403]).toContain(external.status);
    const { runWithRequestAuthority } = await import("../request-authority");
    const { EditorialPlansRepository } = await import("./editorial-plans.repository");
    await expect(
      runWithRequestAuthority(
        {
          kind: "api-key",
          orgId: f.orgId,
          keyId: key.id,
          scope: "generation:create",
          operation: "generation:create",
        },
        () =>
          app.get(EditorialPlansRepository).enable(f.orgId, f.brandId, saved.id, {
            expectedRevision: 1,
            allowPaidGeneration: true,
            consentVersion: PAID_GENERATION_CONSENT_VERSION,
          }),
      ),
    ).rejects.toMatchObject({ response: { code: "editorial_plan_session_required" } });
  });
  it("revalidates an editor grant after a measured parent-lock wait before consent and enqueue", async () => {
    const f = await fixture();
    const saved = await plan(f);
    const editor = await account();
    const memberId = `member-${randomUUID()}`;
    await connection.db
      .insert(schema.member)
      .values({ id: memberId, organizationId: f.orgId, userId: editor.userId, role: "editor" });
    await connection.db
      .insert(schema.brandAccess)
      .values({ orgId: f.orgId, brandId: f.brandId, memberId });
    await editor.client
      .post("/api/auth/organization/set-active")
      .send({ organizationId: f.orgId })
      .expect(200);
    const client = await connection.pool.connect();
    try {
      await client.query("begin");
      await client.query("select id from brands where id=$1 for update", [f.brandId]);
      const enabling = editor.client
        .post(`/api/calendar/editorial-plans/${saved.id}/enable?brandId=${f.brandId}`)
        .send({
          expectedRevision: 1,
          allowPaidGeneration: true,
          consentVersion: PAID_GENERATION_CONSENT_VERSION,
        })
        .then((result) => result);
      let waiting = false;
      for (let attempt = 0; attempt < 300 && !waiting; attempt++) {
        const result = await connection.pool.query(
          `select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%from "brands"%' and query like '%for key share%') as waiting`,
        );
        waiting = result.rows[0]?.waiting === true;
      }
      expect(waiting).toBe(true);
      await client.query(
        "delete from brand_access where org_id=$1 and brand_id=$2 and member_id=$3",
        [f.orgId, f.brandId, memberId],
      );
      await client.query("commit");
      const refusal = await enabling;
      expect(refusal.status).toBe(403);
      expect(refusal.body.code).toBe("editorial_plan_authority_revoked");
      const [unchanged] = await connection.db
        .select({
          revision: schema.editorialPlans.revision,
          enabled: schema.editorialPlans.enabled,
          actor: schema.editorialPlans.consentingActorId,
        })
        .from(schema.editorialPlans)
        .where(eq(schema.editorialPlans.id, saved.id));
      expect(unchanged).toEqual({ revision: 1, enabled: false, actor: null });
      expect(
        (
          await connection.pool.query(
            "select count(*)::int as total from pgboss.job where name='editorial-plan-materialize' and data->>'planId'=$1",
            [saved.id],
          )
        ).rows[0]?.total,
      ).toBe(0);
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
