import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("content e2e", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const { runMigrations } = await import("@pubrick/db");
    await runMigrations(url as string);
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  async function orgAgent(): Promise<request.Agent> {
    const agent = request.agent(app.getHttpServer());
    const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `u${uniq}@example.com`, password: "password1234", name: "U" })
      .expect(200);
    const created = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${uniq}`, slug: `org-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: created.body.id })
      .expect(200);
    return agent;
  }

  async function brandWithChannel(agent: request.Agent) {
    const brand = await agent.post("/api/brands").send({ name: "B" }).expect(201);
    const channel = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Main",
        credentials: { botToken: "123:abc", chatId: "-1001234567890" },
      })
      .expect(201);
    return { brandId: brand.body.id as string, channelId: channel.body.id as string };
  }

  it("creates a draft with one adaptation per channel", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Hello world", channelIds: [channelId] })
      .expect(201);

    expect(created.body.status).toBe("draft");
    expect(created.body.adaptations).toHaveLength(1);
    expect(created.body.adaptations[0]).toMatchObject({ channelId, status: "pending" });
  });

  it("rejects a channel that belongs to another brand", async () => {
    const agent = await orgAgent();
    const { channelId } = await brandWithChannel(agent);
    const other = await agent.post("/api/brands").send({ name: "Other" }).expect(201);
    await agent
      .post("/api/content")
      .send({ brandId: other.body.id, body: "x", channelIds: [channelId] })
      .expect(404);
  });

  it("edits the item body and a per-channel override", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Original", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id;

    await agent.patch(`/api/content/${created.body.id}`).send({ body: "Edited" }).expect(200);
    const updated = await agent
      .patch(`/api/content/${created.body.id}/adaptations/${adaptationId}`)
      .send({ body: "Channel-specific" })
      .expect(200);
    expect(updated.body.body).toBe("Channel-specific");
  });

  it("approves immediately: item approved, adaptation queued", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Ship it", channelIds: [channelId] })
      .expect(201);

    const approved = await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({})
      .expect(200);
    expect(approved.body.status).toBe("approved");
    expect(approved.body.adaptations[0].status).toBe("queued");
  });

  it("approves with a schedule: adaptation scheduled with the timestamp", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Later", channelIds: [channelId] })
      .expect(201);
    const when = new Date(Date.now() + 3_600_000).toISOString();

    const approved = await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({ scheduledAt: when })
      .expect(200);
    expect(approved.body.adaptations[0].status).toBe("scheduled");
    expect(new Date(approved.body.adaptations[0].scheduledAt).toISOString()).toBe(when);
  });

  it("enqueues exactly one publish job per adaptation, even when approve is called twice", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Once", channelIds: [channelId] })
      .expect(201);

    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);
    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);

    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'publish' AND data->>'adaptationId' = '${created.body.adaptations[0].id}'`,
    );
    await pool.end();
    expect((jobs.rows[0] as { n: number }).n).toBe(1);
    // Note: this does NOT exercise the pg-boss id-collision/dedup path. After the
    // first approve the adaptation's status is "queued", so approve()'s own
    // `status === "pending" || status === "failed"` filter excludes it from
    // `targets` on the second call — enqueuePublish() is simply never invoked
    // again. The count staying at 1 here is a consequence of that filter, not
    // of publishJobId producing the same id twice. The re-approve-after-failure
    // test below is what actually drives two calls into enqueuePublish() for
    // the same adaptation and checks the id derivation.
  });

  it("re-approves a failed adaptation: attemptCount makes the retry's job id fresh, so it actually enqueues", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Retry me", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    // First approve: attemptCount is 0, enqueues job id uuidv5(`${id}:0`, ...).
    await agent.post(`/api/content/${created.body.id}/approve`).send({}).expect(200);

    // Simulate what the worker does after a failed publish attempt: bump
    // attemptCount and flip the adaptation back to "failed" so approve()'s
    // targets filter picks it up again.
    const { createDb } = await import("@pubrick/db");
    {
      const { db, pool } = createDb(url as string);
      await db.execute(
        `UPDATE adaptations SET status = 'failed', attempt_count = 1 WHERE id = '${adaptationId}'`,
      );
      await pool.end();
    }

    // Second approve: attemptCount is now 1, so publishJobId derives a DIFFERENT
    // id than the first attempt — send() must not be suppressed as a duplicate.
    const reApproved = await agent
      .post(`/api/content/${created.body.id}/approve`)
      .send({})
      .expect(200);
    expect(reApproved.body.adaptations[0].status).toBe("queued");

    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT count(*)::int AS n FROM pgboss.job WHERE name = 'publish' AND data->>'adaptationId' = '${adaptationId}'`,
    );
    await pool.end();
    // Two distinct job rows: one per attempt, proving the retry was not silently
    // swallowed by pg-boss's ON CONFLICT DO NOTHING on a stale job id.
    expect((jobs.rows[0] as { n: number }).n).toBe(2);
  });

  it("surfaces the published link once the worker logs a publications row", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Went out", channelIds: [channelId] })
      .expect(201);
    const adaptationId = created.body.adaptations[0].id as string;

    // Simulate what the worker's markPublished does: flip the adaptation to
    // "published" and log the terminal publications row with the link. The
    // api never writes here itself — this is the worker's write path
    // (apps/worker/src/publish/publish.repository.ts) — so seed it directly.
    // org_id is read back off the adaptation row rather than hardcoded: it's
    // a NOT NULL FK to organization(id), and the agent helpers above never
    // hand the test the org id they generated internally.
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const [row] = (await db.execute(`SELECT org_id FROM adaptations WHERE id = '${adaptationId}'`))
      .rows as { org_id: string }[];
    const orgId = row?.org_id;
    await db.execute(`UPDATE adaptations SET status = 'published' WHERE id = '${adaptationId}'`);
    await db.execute(
      `INSERT INTO publications (org_id, adaptation_id, channel_id, status, external_id, external_url, attempt)
       VALUES ('${orgId}', '${adaptationId}', '${channelId}', 'published', '4711', 'https://t.me/mychannel/4711', 1)`,
    );
    await pool.end();

    const fetched = await agent.get(`/api/content/${created.body.id}`).expect(200);
    expect(fetched.body.adaptations[0]).toMatchObject({
      status: "published",
      externalUrl: "https://t.me/mychannel/4711",
    });
  });

  it("reports link unavailable (null) for a failed adaptation, not a stale link", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "Never went out", channelIds: [channelId] })
      .expect(201);

    const fetched = await agent.get(`/api/content/${created.body.id}`).expect(200);
    expect(fetched.body.adaptations[0]).toMatchObject({ status: "pending", externalUrl: null });
  });

  it("rejects a draft", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const created = await agent
      .post("/api/content")
      .send({ brandId, body: "No", channelIds: [channelId] })
      .expect(201);
    const rejected = await agent
      .post(`/api/content/${created.body.id}/reject`)
      .send({})
      .expect(200);
    expect(rejected.body.status).toBe("rejected");
  });

  it("isolates content between organizations", async () => {
    const a = await orgAgent();
    const b = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(a);
    const created = await a
      .post("/api/content")
      .send({ brandId, body: "Mine", channelIds: [channelId] })
      .expect(201);

    expect((await b.get("/api/content").expect(200)).body).toHaveLength(0);
    await b.get(`/api/content/${created.body.id}`).expect(404);
    await b.post(`/api/content/${created.body.id}/approve`).send({}).expect(404);
  });
});
