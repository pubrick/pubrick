import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schema } from "@pubrick/db";
import { autopilotManualAttemptSchema } from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("manual Autopilot trigger API", () => {
  let app: INestApplication;
  let db: typeof import("../db")["db"];
  let queue: InstanceType<typeof import("../queue/queue.service").QueueService>;
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    db = (await import("../db")).db;
    const { AppModule } = await import("../app.module");
    const { QueueService } = await import("../queue/queue.service");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
    queue = app.get(QueueService);
  });
  afterAll(async () => {
    await app?.close();
  });

  async function owner() {
    const agent = request.agent(app.getHttpServer());
    const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const signup = await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `manualauto${uniq}@example.com`, password: "password1234", name: "Owner" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${uniq}`, slug: `manual-auto-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return { agent, orgId: org.body.id as string, userId: signup.body.user.id as string };
  }

  it("scopes requests, deduplicates concurrent attempts, enforces cooldown, and allows owner/admin only", async () => {
    const first = await owner();
    const outsider = await owner();
    const brand = await first.agent.post("/api/brands").send({ name: "Brand" }).expect(201);
    const triggerUrl = `/api/brands/${brand.body.id}/autopilot/trigger`;
    const historyUrl = `/api/brands/${brand.body.id}/autopilot/attempts`;
    await outsider.agent.post(triggerUrl).expect(404);
    await outsider.agent.get(historyUrl).expect(404);
    const [a, b] = await Promise.all([first.agent.post(triggerUrl), first.agent.post(triggerUrl)]);
    expect(a.status).toBe(202);
    expect(b.status).toBe(202);
    expect(a.body.id).toBe(b.body.id);
    expect(autopilotManualAttemptSchema.parse(a.body).status).toBe("queued");
    expect((await first.agent.get(historyUrl).expect(200)).body).toHaveLength(1);
    const jobs = await db.execute(sql`
      SELECT id, group_id, retry_limit, dead_letter FROM pgboss.job
      WHERE name = 'autopilot-manual' AND id = ${a.body.id}
    `);
    expect(jobs.rows).toEqual([
      {
        id: a.body.id,
        group_id: first.orgId,
        retry_limit: 0,
        dead_letter: "autopilot-manual-dlq",
      },
    ]);
    await db
      .update(schema.autopilotManualAttempts)
      .set({ status: "completed", decision: "disabled", completedAt: sql`clock_timestamp()` })
      .where(
        and(
          eq(schema.autopilotManualAttempts.orgId, first.orgId),
          eq(schema.autopilotManualAttempts.id, a.body.id),
        ),
      );
    await expect(
      db.execute(
        sql`UPDATE autopilot_manual_attempts SET decision = 'unexpected' WHERE id = ${a.body.id}`,
      ),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint: "autopilot_manual_attempts_decision_check" },
    });
    const cooldown = await first.agent.post(triggerUrl).expect(409);
    expect(cooldown.body.code).toBe("autopilot_trigger_cooldown");
    await db
      .update(schema.autopilotManualAttempts)
      .set({ createdAt: sql`clock_timestamp() - interval '61 seconds'` })
      .where(eq(schema.autopilotManualAttempts.id, a.body.id));
    await first.agent.post(triggerUrl).expect(202);
    expect((await first.agent.get(historyUrl).expect(200)).body).toHaveLength(2);
    await db
      .update(schema.member)
      .set({ role: "member" })
      .where(
        and(eq(schema.member.organizationId, first.orgId), eq(schema.member.userId, first.userId)),
      );
    await first.agent.post(triggerUrl).expect(403);
    await first.agent.get(historyUrl).expect(403);
    await db
      .update(schema.member)
      .set({ role: "admin" })
      .where(
        and(eq(schema.member.organizationId, first.orgId), eq(schema.member.userId, first.userId)),
      );
    await first.agent.get(historyUrl).expect(200);
    await first.agent.post(triggerUrl).expect(202);
  });

  it("rolls back attempt insertion when queue insertion fails", async () => {
    const actor = await owner();
    const brand = await actor.agent
      .post("/api/brands")
      .send({ name: "Rollback Brand" })
      .expect(201);
    const spy = vi
      .spyOn(queue, "enqueueManualAutopilot")
      .mockRejectedValueOnce(new Error("simulated queue failure"));
    try {
      await actor.agent.post(`/api/brands/${brand.body.id}/autopilot/trigger`).expect(500);
    } finally {
      spy.mockRestore();
    }
    expect(
      (await actor.agent.get(`/api/brands/${brand.body.id}/autopilot/attempts`).expect(200)).body,
    ).toEqual([]);
    const jobs = await db.execute(sql`
      SELECT id FROM pgboss.job WHERE name = 'autopilot-manual'
      AND data @> ${JSON.stringify({ orgId: actor.orgId, brandId: brand.body.id })}::jsonb
    `);
    expect(jobs.rows).toHaveLength(0);
  });
});
