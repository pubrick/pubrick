import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schema } from "@pubrick/db";
import { autopilotConfigSchema } from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("autopilot API", () => {
  let app: INestApplication;
  let db: typeof import("../db")["db"];

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    db = (await import("../db")).db;
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  });
  afterAll(async () => {
    await app?.close();
  });

  async function orgAgent() {
    const agent = request.agent(app.getHttpServer());
    const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const signup = await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `autopilot${uniq}@example.com`, password: "password1234", name: "Owner" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${uniq}`, slug: `autopilot-org-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return { agent, orgId: org.body.id as string, userId: signup.body.user.id as string };
  }

  it("requires owner authorization and brand-owned channels, without enabling by default", async () => {
    const owner = await orgAgent();
    const other = await orgAgent();
    const brand = await owner.agent.post("/api/brands").send({ name: "Brand" }).expect(201);
    const channel = await owner.agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Main",
        credentials: { botToken: "123:abc", chatId: "@pubrick" },
      })
      .expect(201);
    const configUrl = `/api/brands/${brand.body.id}/autopilot`;
    const initial = await owner.agent.get(configUrl).expect(200);
    expect(initial.body.enabled).toBe(false);
    expect(initial.body.autoSuggestTopics).toBe(false);
    expect(initial.body.autoPlanTopics).toBe(false);
    expect(initial.body.planningDailyLimit).toBe(1);
    await other.agent.get(configUrl).expect(404);
    await other.agent.get(`${configUrl}/history`).expect(404);
    const payload = {
      ...initial.body,
      enabled: true,
      channelIds: [channel.body.id],
      timezone: "Europe/Moscow",
      startHour: 9,
      quietStartHour: 22,
      quietEndHour: 8,
      dailyRunLimit: 2,
      dailySpendLimitUsd: 1.5,
    };
    expect(autopilotConfigSchema.parse(payload)).toEqual(payload);
    await owner.agent
      .put(configUrl)
      .send({ ...payload, autoSuggestTopics: undefined })
      .expect(200);
    const suggestionsOnly = {
      ...initial.body,
      autoSuggestTopics: true,
    };
    await owner.agent.put(configUrl).send(suggestionsOnly).expect(200);
    expect((await owner.agent.get(configUrl).expect(200)).body).toEqual(suggestionsOnly);
    await owner.agent
      .put(configUrl)
      .send({ ...payload, autoSuggestTopics: undefined })
      .expect(200);
    expect((await owner.agent.get(configUrl).expect(200)).body.autoSuggestTopics).toBe(true);
    await owner.agent
      .put(configUrl)
      .send({ ...payload, channelIds: [brand.body.id] })
      .expect(404);
    await owner.agent
      .put(configUrl)
      .send({ ...payload, timezone: "Mars/Olympus" })
      .expect(400);
    await owner.agent.put(configUrl).send(payload).expect(200);
    expect((await owner.agent.get(configUrl).expect(200)).body).toEqual(payload);
    await owner.agent
      .put(configUrl)
      .send({ ...payload, autoSuggestTopics: true })
      .expect(200);
    expect((await owner.agent.get(configUrl).expect(200)).body.autoSuggestTopics).toBe(true);
    await owner.agent
      .put(configUrl)
      .send({
        ...payload,
        enabled: false,
        autoSuggestTopics: undefined,
        autoPlanTopics: true,
        planningDailyLimit: 3,
      })
      .expect(200);
    expect((await owner.agent.get(configUrl).expect(200)).body).toMatchObject({
      enabled: false,
      autoPlanTopics: true,
      planningDailyLimit: 3,
    });
    await owner.agent
      .put(configUrl)
      .send({ ...payload, enabled: false, autoPlanTopics: true, channelIds: [] })
      .expect(400);
    await owner.agent
      .put(configUrl)
      .send({ ...payload, enabled: false, autoPlanTopics: true, planningDailyLimit: 0 })
      .expect(400);
    // A previous client version omits the new keys. Both values survive its PUT.
    await owner.agent
      .put(configUrl)
      .send({
        ...payload,
        enabled: false,
        autoSuggestTopics: undefined,
        autoPlanTopics: undefined,
        planningDailyLimit: undefined,
      })
      .expect(200);
    expect((await owner.agent.get(configUrl).expect(200)).body).toMatchObject({
      enabled: false,
      autoPlanTopics: true,
      planningDailyLimit: 3,
    });
    await owner.agent
      .put(configUrl)
      .send({
        ...payload,
        enabled: false,
        autoSuggestTopics: undefined,
        channelIds: [],
        autoPlanTopics: undefined,
      })
      .expect(400);
    await expect(
      db.execute(
        sql`update autopilot_configs set planning_daily_limit = 6 where brand_id = ${brand.body.id}`,
      ),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await db
      .update(schema.member)
      .set({ role: "member" })
      .where(
        and(eq(schema.member.organizationId, owner.orgId), eq(schema.member.userId, owner.userId)),
      );
    await owner.agent
      .put(configUrl)
      .send({ ...payload, enabled: false, autoSuggestTopics: false })
      .expect(403);
    await owner.agent.get(configUrl).expect(404);
    await db
      .update(schema.member)
      .set({ role: "owner" })
      .where(
        and(eq(schema.member.organizationId, owner.orgId), eq(schema.member.userId, owner.userId)),
      );
    const afterDenied = (await owner.agent.get(configUrl).expect(200)).body;
    expect(afterDenied.enabled).toBe(false);
    expect(afterDenied.autoSuggestTopics).toBe(true);
    expect(afterDenied.autoPlanTopics).toBe(true);
  });

  it("queues a manual planning pass once per brand per minute", async () => {
    const owner = await orgAgent();
    const other = await orgAgent();
    const brand = await owner.agent.post("/api/brands").send({ name: "Plan Brand" }).expect(201);
    const channel = await owner.agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Main",
        credentials: { botToken: "123:abc", chatId: "@pubrick" },
      })
      .expect(201);
    const configUrl = `/api/brands/${brand.body.id}/autopilot`;
    const planUrl = `${configUrl}/plan-topics`;
    await owner.agent
      .post(planUrl)
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe("topic_planning_disabled");
      });
    await other.agent.post(planUrl).expect(404);

    const defaults = (await owner.agent.get(configUrl).expect(200)).body;
    await owner.agent
      .put(configUrl)
      .send({ ...defaults, enabled: false, autoPlanTopics: true, channelIds: [channel.body.id] })
      .expect(200);

    const [first, second] = await Promise.all([
      owner.agent.post(planUrl),
      owner.agent.post(planUrl),
    ]);
    expect([first.status, second.status].sort()).toEqual([202, 409]);
    const accepted = first.status === 202 ? first : second;
    const denied = first.status === 409 ? first : second;
    expect(accepted.body).toEqual({ status: "queued" });
    expect(denied.body.code).toBe("topic_planning_cooldown");

    const jobs = await db.execute(sql`
      SELECT id, state FROM pgboss.job
      WHERE name = 'topic-plan-manual'
        AND data @> ${JSON.stringify({ orgId: owner.orgId, brandId: brand.body.id })}::jsonb
    `);
    expect(jobs.rows).toHaveLength(1);
    const admitted = await db
      .select({ lastManualPlanAt: schema.autopilotConfigs.lastManualPlanAt })
      .from(schema.autopilotConfigs)
      .where(eq(schema.autopilotConfigs.brandId, brand.body.id));
    expect(admitted[0]?.lastManualPlanAt).toBeInstanceOf(Date);

    // Saving ordinary autopilot settings cannot clear the manual admission
    // clock or permit another pass inside the same minute.
    await owner.agent
      .put(configUrl)
      .send({ ...defaults, enabled: false, autoPlanTopics: true, channelIds: [channel.body.id] })
      .expect(200);
    const afterPut = await db
      .select({ lastManualPlanAt: schema.autopilotConfigs.lastManualPlanAt })
      .from(schema.autopilotConfigs)
      .where(eq(schema.autopilotConfigs.brandId, brand.body.id));
    expect(afterPut[0]?.lastManualPlanAt).toEqual(admitted[0]?.lastManualPlanAt);

    // Completion cannot lift the cooldown: a fast worker must not enable
    // repeated operator submissions within the same rolling minute.
    await db.execute(sql`
      UPDATE pgboss.job SET state = 'completed'
      WHERE name = 'topic-plan-manual' AND id = ${String(jobs.rows[0]?.id)}::uuid
    `);
    await owner.agent
      .post(planUrl)
      .expect(409)
      .expect(({ body }) => {
        expect(body.code).toBe("topic_planning_cooldown");
      });
    await db.execute(sql`
      UPDATE autopilot_configs
      SET last_manual_plan_at = clock_timestamp() - interval '61 seconds'
      WHERE brand_id = ${brand.body.id}::uuid
    `);
    await owner.agent.post(planUrl).expect(202);
    const after = await db.execute(sql`
      SELECT count(*)::int AS count FROM pgboss.job
      WHERE name = 'topic-plan-manual'
        AND data @> ${JSON.stringify({ orgId: owner.orgId, brandId: brand.body.id })}::jsonb
    `);
    expect((after.rows[0] as { count: number }).count).toBe(2);

    // A selected channel can be deleted after the config was saved. Do not
    // enqueue a pass that the worker would have to discard.
    await owner.agent.delete(`/api/channels/${channel.body.id}`).expect(200);
    await owner.agent
      .post(planUrl)
      .expect(400)
      .expect(({ body }) => {
        expect(body.code).toBe("brand_has_no_channels");
      });

    await db
      .update(schema.member)
      .set({ role: "member" })
      .where(
        and(eq(schema.member.organizationId, owner.orgId), eq(schema.member.userId, owner.userId)),
      );
    await owner.agent.post(planUrl).expect(403);
  });

  it("rolls back the admission clock if enqueue fails", async () => {
    const owner = await orgAgent();
    const brand = await owner.agent
      .post("/api/brands")
      .send({ name: "Rollback Brand" })
      .expect(201);
    const channel = await owner.agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Main",
        credentials: { botToken: "123:abc", chatId: "@pubrick" },
      })
      .expect(201);
    const configUrl = `/api/brands/${brand.body.id}/autopilot`;
    const defaults = (await owner.agent.get(configUrl).expect(200)).body;
    await owner.agent
      .put(configUrl)
      .send({ ...defaults, autoPlanTopics: true, channelIds: [channel.body.id] })
      .expect(200);

    const { QueueService } = await import("../queue/queue.service");
    const spy = vi
      .spyOn(app.get(QueueService), "enqueueManualTopicPlan")
      .mockRejectedValueOnce(new Error("simulated queue outage"));
    try {
      await owner.agent.post(`${configUrl}/plan-topics`).expect(500);
    } finally {
      spy.mockRestore();
    }
    const [config] = await db
      .select({ lastManualPlanAt: schema.autopilotConfigs.lastManualPlanAt })
      .from(schema.autopilotConfigs)
      .where(eq(schema.autopilotConfigs.brandId, brand.body.id));
    expect(config?.lastManualPlanAt).toBeNull();
    await owner.agent.post(`${configUrl}/plan-topics`).expect(202);
  });
});
