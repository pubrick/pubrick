import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { MAX_CONCURRENT_RUNS } from "@pubrick/shared";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("runs e2e", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    // Migrations run once for the whole suite in vitest.global-setup.ts.
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

  /**
   * Drives a run to a terminal state the way the worker would. There is no
   * worker in this suite (Task 8 owns it), and the point of these tests is what
   * the API does with the resulting row, not how it got there.
   */
  async function setRunStatus(runId: string, status: string, error?: string) {
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    await db.execute(
      `UPDATE pipeline_runs SET status = '${status}', error = ${error ? `'${error}'` : "NULL"},
         updated_at = now() WHERE id = '${runId}'`,
    );
    await pool.end();
  }

  async function startRun(agent: request.Agent, brandId: string, channelIds: string[]) {
    const created = await agent
      .post("/api/runs")
      .send({ brandId, brief: "Write about our new release", channelIds })
      .expect(201);
    return created.body as { id: string; status: string; input: { channelIds: string[] } };
  }

  it("queues a run and enqueues exactly one generate job for it", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const run = await startRun(agent, brandId, [channelId]);

    expect(run.status).toBe("queued");
    expect(run.input).toMatchObject({
      kind: "brief",
      text: "Write about our new release",
      channelIds: [channelId],
    });

    // The row alone proves nothing: the whole reason the insert and the send
    // share a transaction is that a `queued` run with no job behind it is a
    // stall nobody can see. Assert the job actually exists.
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT count(*)::int AS n FROM pgboss.job
         WHERE name = 'generate' AND data->>'runId' = '${run.id}'`,
    );
    await pool.end();
    expect((jobs.rows[0] as { n: number }).n).toBe(1);
  });

  it("refuses a brand with no channels (400): a run with no channels produces an item with zero adaptations", async () => {
    const agent = await orgAgent();
    const emptyBrand = await agent.post("/api/brands").send({ name: "No channels" }).expect(201);
    const { channelId } = await brandWithChannel(agent);

    // Whatever channel ids are offered, a brand with nothing to publish to is
    // refused up front and by name — not with "those channels aren't yours".
    const denied = await agent
      .post("/api/runs")
      .send({ brandId: emptyBrand.body.id, brief: "Anything", channelIds: [channelId] })
      .expect(400);
    expect(denied.body.message).toBe("This brand has no channels; add one before generating");

    // And the request-shaped half of the same rule, matching
    // contentCreateSchema's channelIds.min(1).
    await agent
      .post("/api/runs")
      .send({ brandId: emptyBrand.body.id, brief: "Anything", channelIds: [] })
      .expect(400);
  });

  it("refuses a fourth concurrent run (409) and names the limit", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);

    for (let i = 0; i < MAX_CONCURRENT_RUNS; i++) {
      await startRun(agent, brandId, [channelId]);
    }

    const denied = await agent
      .post("/api/runs")
      .send({ brandId, brief: "One too many", channelIds: [channelId] })
      .expect(409);
    // The number is in the message: "too many runs" leaves the user guessing
    // how many is too many, and the web app renders the same figure from the
    // shared MAX_CONCURRENT_RUNS.
    expect(denied.body.message).toContain(String(MAX_CONCURRENT_RUNS));

    // The cap counts only queued|running, so finishing one admits the next.
    const open = await agent.get("/api/runs?state=open").expect(200);
    await setRunStatus(open.body[0].id, "succeeded");
    await startRun(agent, brandId, [channelId]);
  });

  it("caps by org, not globally: another org is unaffected", async () => {
    const first = await orgAgent();
    const firstBrand = await brandWithChannel(first);
    for (let i = 0; i < MAX_CONCURRENT_RUNS; i++) {
      await startRun(first, firstBrand.brandId, [firstBrand.channelId]);
    }
    await first
      .post("/api/runs")
      .send({ brandId: firstBrand.brandId, brief: "x", channelIds: [firstBrand.channelId] })
      .expect(409);

    const second = await orgAgent();
    const secondBrand = await brandWithChannel(second);
    await startRun(second, secondBrand.brandId, [secondBrand.channelId]);
  });

  it("cancels a queued run: status moves to cancelled, the job is cancelled, updated_at advances", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const run = await startRun(agent, brandId, [channelId]);
    const before = await agent.get(`/api/runs/${run.id}`).expect(200);

    const cancelled = await agent.post(`/api/runs/${run.id}/cancel`).expect(200);
    expect(cancelled.body.status).toBe("cancelled");
    // Raw-SQL updates do not fire Drizzle's $onUpdate; this write goes through
    // the query builder precisely so the timestamp cannot silently freeze.
    expect(new Date(cancelled.body.updatedAt).getTime()).toBeGreaterThan(
      new Date(before.body.updatedAt).getTime(),
    );

    // Flipping the status alone would not be a cancellation: the job would keep
    // spending the org's money and then write a content item nobody asked for.
    const { createDb } = await import("@pubrick/db");
    const { db, pool } = createDb(url as string);
    const jobs = await db.execute(
      `SELECT state FROM pgboss.job WHERE name = 'generate' AND data->>'runId' = '${run.id}'`,
    );
    await pool.end();
    expect((jobs.rows[0] as { state: string }).state).toBe("cancelled");

    // Cancelling twice is refused in the words of the status on screen.
    const again = await agent.post(`/api/runs/${run.id}/cancel`).expect(409);
    expect(again.body.message).toBe("This run has already been cancelled");
  });

  it("keeps a failed, undismissed run on the open list and drops it once dismissed", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const failed = await startRun(agent, brandId, [channelId]);
    const queued = await startRun(agent, brandId, [channelId]);
    await setRunStatus(failed.id, "failed", "the model could not fit the channel limit");

    const open = await agent.get("/api/runs?state=open").expect(200);
    const ids = open.body.map((run: { id: string }) => run.id);
    expect(ids).toContain(failed.id);
    expect(ids).toContain(queued.id);
    // Failures sort first: a failed run creates no content item, so a strip
    // buried under successful chatter is a failure that is invisible everywhere.
    expect(open.body[0].id).toBe(failed.id);
    expect(open.body[0].error).toBe("the model could not fit the channel limit");

    const dismissed = await agent.post(`/api/runs/${failed.id}/dismiss`).expect(200);
    expect(dismissed.body.dismissedAt).not.toBeNull();

    const after = await agent.get("/api/runs?state=open").expect(200);
    expect(after.body.map((run: { id: string }) => run.id)).not.toContain(failed.id);
    // Dismissing clears the strip, never the record: the run is still there.
    const all = await agent.get("/api/runs").expect(200);
    expect(all.body.map((run: { id: string }) => run.id)).toContain(failed.id);
  });

  it("hides a succeeded run from the open list without needing a dismiss", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const run = await startRun(agent, brandId, [channelId]);
    await setRunStatus(run.id, "succeeded");

    const open = await agent.get("/api/runs?state=open").expect(200);
    expect(open.body.map((r: { id: string }) => r.id)).not.toContain(run.id);
    // ...and a run still in flight cannot be dismissed off the strip.
    const live = await startRun(agent, brandId, [channelId]);
    const denied = await agent.post(`/api/runs/${live.id}/dismiss`).expect(409);
    expect(denied.body.message).toBe("A queued run cannot be dismissed; cancel it first");
  });

  it("400s an unknown state without pretending it is a status enum member", async () => {
    const agent = await orgAgent();
    const denied = await agent.get("/api/runs?state=queued").expect(400);
    // `queued` IS a run status, and that is the point: `state` is a different
    // vocabulary, so copying the content list's status validation here would
    // have rejected `open` — the only value the queue strip ever sends.
    expect(denied.body.message).toContain("Expected one of: open, all");
    await agent.get("/api/runs?state=open").expect(200);
  });

  it("scopes every run to its org", async () => {
    const owner = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(owner);
    const run = await startRun(owner, brandId, [channelId]);

    const stranger = await orgAgent();
    await stranger.get(`/api/runs/${run.id}`).expect(404);
    await stranger.post(`/api/runs/${run.id}/cancel`).expect(404);
    await stranger.post(`/api/runs/${run.id}/dismiss`).expect(404);
    expect((await stranger.get("/api/runs").expect(200)).body).toEqual([]);
  });

  it("refuses a channel from another brand (404) and a duplicated channel (400)", async () => {
    const agent = await orgAgent();
    const { brandId, channelId } = await brandWithChannel(agent);
    const other = await brandWithChannel(agent);

    await agent
      .post("/api/runs")
      .send({ brandId, brief: "x", channelIds: [other.channelId] })
      .expect(404);

    // A repeat is a PAID adapter call made twice for one channel, so it is
    // rejected rather than quietly deduped.
    await agent
      .post("/api/runs")
      .send({ brandId, brief: "x", channelIds: [channelId, channelId] })
      .expect(400);
  });
});
