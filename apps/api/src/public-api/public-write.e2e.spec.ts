import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createDb, schema } from "@pubrick/db";
import { encryptJson, PAID_GENERATION_CONSENT_VERSION } from "@pubrick/shared";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runWithRequestAuthority } from "../request-authority";
import type { PublicRateLimitService } from "./public-rate-limit.service";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("native scoped writes and committed replay", () => {
  let app: NestExpressApplication;
  let connection: ReturnType<typeof createDb>;
  let limiter: PublicRateLimitService;
  const orgs: string[] = [];
  const keyRing = "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
  beforeAll(async () => {
    if (
      !url ||
      !/^pubrick(?:_[a-z0-9]+)*_test$/.test(new URL(url).pathname.slice(1)) ||
      !["localhost", "127.0.0.1"].includes(new URL(url).hostname)
    )
      throw new Error("Only a loopback disposable pubrick_*_test database is allowed");
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET = "scoped-write-native-test-secret";
    process.env.APP_ENCRYPTION_KEY = keyRing;
    process.env.PUBLIC_API_MAX_OPERATION_RECORDS = "3";
    const { AppModule } = await import("../app.module");
    const { installBillingWebhookParser } = await import("../billing/webhook-parser");
    const { installPublicWriteParser } = await import("./public-write-parser");
    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      bodyParser: false,
      rawBody: true,
      logger: false,
    });
    installBillingWebhookParser(app);
    installPublicWriteParser(app);
    app.setGlobalPrefix("api");
    await app.init();
    connection = createDb(url);
    const { PublicRateLimitService } = await import("./public-rate-limit.service");
    limiter = app.get(PublicRateLimitService);
  });
  afterAll(async () => {
    await app?.close();
    for (const org of orgs)
      await connection.db.delete(schema.organization).where(eq(schema.organization.id, org));
    await connection?.pool.end();
    const { pool } = await import("../db");
    await pool.end();
  });
  async function fixture() {
    const orgId = `scoped-${randomUUID()}`,
      userId = randomUUID();
    orgs.push(orgId);
    await connection.db.insert(schema.user).values({
      id: userId,
      name: "Fixture",
      email: `${userId}@example.test`,
      emailVerified: true,
    });
    await connection.db
      .insert(schema.organization)
      .values({ id: orgId, name: "Fixture", slug: orgId });
    const [brand] = await connection.db
      .insert(schema.brands)
      .values({ orgId, name: "Fixture" })
      .returning({ id: schema.brands.id });
    if (!brand) throw Error("Missing brand");
    const [channel] = await connection.db
      .insert(schema.channels)
      .values({
        orgId,
        brandId: brand.id,
        name: "Manual",
        platform: "t_j",
        credentialsEncrypted: null,
      })
      .returning({ id: schema.channels.id });
    if (!channel) throw Error("Missing channel");
    const { ApiKeysRepository } = await import("./api-keys.repository");
    const keys = app.get(ApiKeysRepository);
    const content = await keys.create(orgId, userId, { name: "Draft", scope: "content:create" });
    const generation = await keys.create(orgId, userId, {
      name: "Generate",
      scope: "generation:create",
    });
    const read = await keys.create(orgId, userId, { name: "Read", scope: "content:read" });
    await connection.db.insert(schema.aiCredentials).values({
      orgId,
      provider: "openai",
      credentialsEncrypted: encryptJson({ apiKey: "synthetic-never-dispatched" }, keyRing),
      defaultModel: "gpt-5.4",
    });
    return {
      orgId,
      userId,
      brandId: brand.id,
      channelId: channel.id,
      content,
      generation,
      read,
      keys,
    };
  }
  const draft = (f: Awaited<ReturnType<typeof fixture>>, body = "Imported fixture") => ({
    brandId: f.brandId,
    channelIds: [f.channelId],
    body,
  });
  const run = (f: Awaited<ReturnType<typeof fixture>>) => ({
    brandId: f.brandId,
    channelIds: [f.channelId],
    brief: "Synthetic never dispatched",
    allowPaidGeneration: true,
    consentVersion: PAID_GENERATION_CONSENT_VERSION,
  });
  const post = (path: string, key: string, idempotency: string, body: object) =>
    request(app.getHttpServer())
      .post(`/api/v2/${path}`)
      .set("Authorization", `Bearer ${key}`)
      .set("Idempotency-Key", idempotency)
      .send(body);
  async function facts(orgId: string) {
    const value = await connection.db.execute(
      sql`SELECT (SELECT count(*)::int FROM public_api_operations WHERE org_id=${orgId}) AS operations,(SELECT count(*)::int FROM content_items WHERE org_id=${orgId}) AS content,(SELECT count(*)::int FROM pipeline_runs WHERE org_id=${orgId}) AS runs,(SELECT count(*)::int FROM pgboss.job WHERE name='generate' AND data->>'orgId'=${orgId}) AS jobs`,
    );
    return value.rows[0];
  }
  it("concurrent identical draft requests commit one result, immutable external history and no automatic review", async () => {
    const f = await fixture();
    const replies = await Promise.all(
      Array.from({ length: 8 }, () => post("content", f.content.key, "draft.same-1", draft(f))),
    );
    expect(replies.map((r) => r.status)).toEqual(Array(8).fill(201));
    expect(new Set(replies.map((r) => r.body.id)).size).toBe(1);
    expect(replies[0]?.body).toEqual({
      id: replies[0]?.body.id,
      status: "draft",
      origin: "external",
      requiresReview: true,
    });
    expect(await facts(f.orgId)).toMatchObject({ operations: 1, content: 1, runs: 0, jobs: 0 });
    const [item] = await connection.db
      .select({
        origin: schema.contentItems.origin,
        review: schema.contentItems.requiresImportedReview,
        opened: schema.contentItems.firstOpenedAt,
      })
      .from(schema.contentItems)
      .where(eq(schema.contentItems.orgId, f.orgId));
    expect(item).toEqual({ origin: "external", review: true, opened: null });
    const versions = await connection.db
      .select({
        origin: schema.contentVersions.origin,
        body: schema.contentVersions.body,
        scope: schema.contentVersions.scope,
      })
      .from(schema.contentVersions)
      .where(eq(schema.contentVersions.orgId, f.orgId));
    expect(versions).toEqual([{ origin: "external", body: "Imported fixture", scope: "full" }]);
    expect(
      (await post("content", f.content.key, "draft.same-1", draft(f, "Changed"))).body.code,
    ).toBe("idempotency_conflict");
    expect(
      (
        await request(app.getHttpServer())
          .get(`/api/v1/content/${replies[0]?.body.id}`)
          .set("Authorization", `Bearer ${f.read.key}`)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app.getHttpServer())
          .get(`/api/v2/content/${replies[0]?.body.id}`)
          .set("Authorization", `Bearer ${f.read.key}`)
      ).body.origin,
    ).toBe("external");
  });
  it("commits one real generation job and original consent audit, and replays before changed AI settings/full queue", async () => {
    const f = await fixture();
    const replies = await Promise.all(
      Array.from({ length: 6 }, () => post("runs", f.generation.key, "generation.same", run(f))),
    );
    expect(replies.map((r) => r.status)).toEqual(Array(6).fill(201));
    const id = replies[0]?.body.id;
    expect(new Set(replies.map((r) => r.body.id)).size).toBe(1);
    expect(await facts(f.orgId)).toMatchObject({ operations: 1, runs: 1, jobs: 1 });
    const [audit] = await connection.db
      .select({
        keyId: schema.publicApiOperations.keyId,
        resultId: schema.publicApiOperations.resultId,
        consent: schema.publicApiOperations.consentVersion,
      })
      .from(schema.publicApiOperations)
      .where(eq(schema.publicApiOperations.orgId, f.orgId));
    expect(audit).toEqual({
      keyId: f.generation.id,
      resultId: id,
      consent: PAID_GENERATION_CONSENT_VERSION,
    });
    const [stored] = await connection.db
      .select({ selection: schema.pipelineRuns.textSelection })
      .from(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, id));
    expect(stored?.selection).toMatchObject({ provider: "openai", modelId: "gpt-5.4" });
    await post("runs", f.generation.key, "generation.second", run(f)).expect(201);
    await post("runs", f.generation.key, "generation.third", run(f)).expect(201);
    await connection.db.delete(schema.aiCredentials).where(eq(schema.aiCredentials.orgId, f.orgId));
    expect((await post("runs", f.generation.key, "generation.same", run(f))).body).toEqual({
      id,
      status: "queued",
    });
    expect(await facts(f.orgId)).toMatchObject({ operations: 3, runs: 3, jobs: 3 });
    expect(
      (
        await request(app.getHttpServer())
          .get(`/api/v2/runs/${id}`)
          .set("Authorization", `Bearer ${f.generation.key}`)
      ).body,
    ).toEqual({
      id,
      status: "queued",
      contentItemId: null,
      error: null,
      cost: { status: "unknown" },
    });
  });
  it("an admitted public run completes through the real worker with scripted models, actual usage and AI provenance after key revocation", async () => {
    const f = await fixture();
    const created = await post("runs", f.generation.key, "generation.worker", run(f)).expect(201);
    await f.keys.revoke(f.orgId, f.generation.id);
    // Runtime cross-app imports keep the test-only worker machinery outside API's production rootDir/bundle.
    // Only the maintained model test fixture is replaced; repositories, fences, SDK call metering and terminal writes are real.
    const workerPath = `${path.resolve(process.cwd(), "../worker/src")}/`;
    const { scriptedModel } = (await import(`${workerPath}test/scripted-model`)) as {
      scriptedModel: () => { model: unknown; callsFor: (role: string) => number };
    };
    const { GenerateRepository } = (await import(`${workerPath}generate/generate.repository`)) as {
      GenerateRepository: new () => unknown;
    };
    const { GenerateService } = (await import(`${workerPath}generate/generate.service`)) as {
      GenerateService: new (
        repo: unknown,
        factory: () => unknown,
        retries: number,
      ) => {
        handle: (job: { id: string; data: { runId: string; orgId: string } }) => Promise<void>;
      };
    };
    const script = scriptedModel();
    const service = new GenerateService(new GenerateRepository(), () => script.model, 0);
    const { PgBoss } = await import("pg-boss");
    const boss = new PgBoss(url as string);
    boss.on("error", () => {
      throw Error("Synthetic queue fixture failed");
    });
    await boss.start();
    // Actual persisted API queue; ignore other synthetic fixture groups instead of consuming their requests.
    const groups = await connection.pool.query<{ group_id: string }>(
      "SELECT DISTINCT group_id FROM pgboss.job WHERE name='generate' AND group_id IS NOT NULL AND group_id<>$1",
      [f.orgId],
    );
    try {
      const jobs = await boss.fetch<{ runId: string; orgId: string }>("generate", {
        ignoreGroups: groups.rows.map((row) => row.group_id),
        batchSize: 1,
      });
      expect(jobs).toHaveLength(1);
      const job = jobs[0];
      if (!job) throw Error("Missing actual generation job");
      expect(job.data.runId).toBe(created.body.id);
      await service.handle(job);
      await boss.complete("generate", job.id);
      const completed = await connection.pool.query<{ state: string }>(
        "SELECT state FROM pgboss.job WHERE name='generate' AND id=$1",
        [job.id],
      );
      expect(completed.rows[0]?.state).toBe("completed");
    } finally {
      await boss.stop();
    }
    const replacement = await f.keys.create(f.orgId, f.userId, {
      name: "Poll",
      scope: "generation:create",
    });
    const poll = await request(app.getHttpServer())
      .get(`/api/v2/runs/${created.body.id}`)
      .set("Authorization", `Bearer ${replacement.key}`)
      .expect(200);
    expect(poll.body.status).toBe("succeeded");
    expect(poll.body.contentItemId).toBeTruthy();
    expect(poll.body).not.toHaveProperty("input");
    expect(poll.body).not.toHaveProperty("steps");
    expect(script.callsFor("writer")).toBe(1);
    const [item] = await connection.db
      .select({
        origin: schema.contentItems.origin,
        review: schema.contentItems.requiresImportedReview,
      })
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, poll.body.contentItemId));
    expect(item).toEqual({ origin: "ai", review: false });
    const ledger = await connection.db
      .select({ step: schema.usageLedger.step, cost: schema.usageLedger.costUsd })
      .from(schema.usageLedger)
      .where(eq(schema.usageLedger.runId, created.body.id));
    expect(ledger.length).toBeGreaterThan(2);
    expect(ledger.some((entry) => entry.step === "writer")).toBe(true);
    expect((await post("runs", replacement.key, "generation.worker", run(f))).body).toEqual(
      created.body,
    );
    const workerDb = (await import(`${workerPath}db`)) as { pool: { end: () => Promise<void> } };
    await workerDb.pool.end();
  });
  it("unknown or lost physical call costs remain unknown rather than a misleading sum", async () => {
    const f = await fixture();
    const created = await post("runs", f.generation.key, "generation.cost", run(f)).expect(201);
    await connection.db.insert(schema.usageLedger).values({
      orgId: f.orgId,
      runId: created.body.id,
      step: "writer",
      provider: "openai",
      modelId: "synthetic",
      costUsd: "0.25",
      costSource: "provider_reported",
      status: "ok",
    });
    const poll = () =>
      request(app.getHttpServer())
        .get(`/api/v2/runs/${created.body.id}`)
        .set("Authorization", `Bearer ${f.generation.key}`);
    expect((await poll()).body.cost).toEqual({
      status: "known",
      amountUsd: "0.250000",
      estimated: false,
    });
    await connection.db.insert(schema.usageLedger).values({
      orgId: f.orgId,
      runId: created.body.id,
      step: "adapter",
      provider: "openai",
      modelId: "synthetic",
      costUsd: "0.125",
      costSource: "price_table",
      status: "ok",
    });
    expect((await poll()).body.cost).toEqual({
      status: "known",
      amountUsd: "0.375000",
      estimated: true,
    });
    await connection.db
      .update(schema.pipelineRuns)
      .set({ unrecordedCalls: 1 })
      .where(eq(schema.pipelineRuns.id, created.body.id));
    expect((await poll()).body.cost).toEqual({ status: "unknown" });
    await connection.db
      .update(schema.pipelineRuns)
      .set({ unrecordedCalls: 0 })
      .where(eq(schema.pipelineRuns.id, created.body.id));
    await connection.db.insert(schema.usageLedger).values({
      orgId: f.orgId,
      runId: created.body.id,
      step: "researcher",
      provider: "openai",
      modelId: "synthetic",
      costUsd: "0.25",
      costSource: "unknown",
      status: "ok",
    });
    expect((await poll()).body.cost).toEqual({ status: "unknown" });
    await connection.db.insert(schema.usageLedger).values({
      orgId: f.orgId,
      runId: created.body.id,
      step: "editor",
      provider: "openai",
      modelId: "synthetic",
      costUsd: null,
      costSource: "unknown",
      status: "ok",
    });
    expect((await poll()).body.cost).toEqual({ status: "unknown" });
  });
  it("fresh key and tenant checks refuse requests whose authority changes while admission waits", async () => {
    const f = await fixture();
    const holder = await connection.pool.connect();
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(31249,hashtext($1))", [f.orgId]);
    const pending = post("content", f.content.key, "draft.revocationwait", draft(f)).then(
      (response) => response,
    );
    try {
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const state = await connection.pool.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND pid<>pg_backend_pid()",
        );
        if (state.rows[0].n) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await f.keys.revoke(f.orgId, f.content.id);
      await holder.query("COMMIT");
      expect((await pending).status).toBe(403);
      expect(await facts(f.orgId)).toMatchObject({ operations: 0, content: 0 });
    } finally {
      await holder.query("ROLLBACK");
      holder.release();
    }
    const gone = await fixture();
    const tenantHolder = await connection.pool.connect();
    await tenantHolder.query("BEGIN");
    await tenantHolder.query("SELECT pg_advisory_xact_lock(31249,hashtext($1))", [gone.orgId]);
    const stopped = post("content", gone.content.key, "draft.tenantwait", draft(gone)).then(
      (response) => response,
    );
    try {
      let waiting = false;
      for (let i = 0; i < 100; i++) {
        const state = await connection.pool.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event='advisory' AND pid<>pg_backend_pid()",
        );
        if (state.rows[0].n) {
          waiting = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await connection.db.delete(schema.organization).where(eq(schema.organization.id, gone.orgId));
      await tenantHolder.query("COMMIT");
      expect((await stopped).status).toBe(403);
    } finally {
      await tenantHolder.query("ROLLBACK");
      tenantHolder.release();
    }
  });
  it("actual pg-boss insertion rolls back with its run and audit when the enclosing writer fails", async () => {
    const f = await fixture();
    const { QueueService } = await import("../queue/queue.service");
    const queue = app.get(QueueService);
    const original = queue.enqueueGenerate.bind(queue);
    const spy = vi.spyOn(queue, "enqueueGenerate").mockImplementationOnce(async (tx, value) => {
      await original(tx, value);
      throw Error("Synthetic post-send failure");
    });
    try {
      expect((await post("runs", f.generation.key, "generation.failed", run(f))).body.code).toBe(
        "public_request_unavailable",
      );
      expect(await facts(f.orgId)).toMatchObject({ operations: 0, runs: 0, jobs: 0 });
    } finally {
      spy.mockRestore();
    }
    await post("runs", f.generation.key, "generation.failed", run(f)).expect(201);
  });
  it("replacement keys recover the same result, revoked/read/wrong-operation keys cannot write or replay", async () => {
    const f = await fixture();
    const first = await post("content", f.content.key, "draft.rotation", draft(f)).expect(201);
    await f.keys.revoke(f.orgId, f.content.id);
    await post("content", f.content.key, "draft.rotation", draft(f)).expect(401);
    const replacement = await f.keys.create(f.orgId, f.userId, {
      name: "Replacement",
      scope: "content:create",
    });
    expect((await post("content", replacement.key, "draft.rotation", draft(f))).body).toEqual(
      first.body,
    );
    await post("content", f.read.key, "draft.readonly", draft(f)).expect(401);
    await post("runs", replacement.key, "draft.wrongscope", run(f)).expect(401);
    const { RunsRepository } = await import("../runs/runs.repository");
    await expect(
      runWithRequestAuthority(
        {
          kind: "api-key",
          orgId: f.orgId,
          keyId: f.generation.id,
          scope: "generation:create",
          operation: "generation:create",
        },
        () => app.get(RunsRepository).create(f.orgId, run(f)),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("deleted results retain lifetime operation capacity and return gone instead of regenerating", async () => {
    const f = await fixture();
    const first = await post("content", f.content.key, "draft.deleted", draft(f)).expect(201);
    await connection.db
      .delete(schema.contentItems)
      .where(eq(schema.contentItems.id, first.body.id));
    expect((await post("content", f.content.key, "draft.deleted", draft(f))).body.code).toBe(
      "public_result_gone",
    );
    await post("content", f.content.key, "draft.second", draft(f)).expect(201);
    await post("content", f.content.key, "draft.third", draft(f)).expect(201);
    expect((await post("content", f.content.key, "draft.fourth", draft(f))).body.code).toBe(
      "public_operation_capacity",
    );
    expect(await facts(f.orgId)).toMatchObject({ operations: 3, content: 2 });
  });
  it("refuses cross-organization targets and strict/missing consent/header fields before writes", async () => {
    const f = await fixture(),
      other = await fixture();
    await post("content", f.content.key, "draft.crossorg", draft(other)).expect(403);
    await post("content", f.content.key, "draft.extrafield", {
      ...draft(f),
      status: "approved",
    }).expect(400);
    await post("runs", f.generation.key, "run.noconsent", {
      brandId: f.brandId,
      channelIds: [f.channelId],
      brief: "Fixture",
    }).expect(400);
    await request(app.getHttpServer())
      .post("/api/v2/content")
      .set("Authorization", `Bearer ${f.content.key}`)
      .send(draft(f))
      .expect(400);
    expect(await facts(f.orgId)).toMatchObject({ operations: 0, content: 0, runs: 0, jobs: 0 });
  });
  it("enforces independent PostgreSQL key/org counters including replays with Retry-After", async () => {
    const f = await fixture();
    for (let i = 0; i < 30; i++)
      await post("content", f.content.key, "draft.ratefixture", draft(f)).expect(201);
    const limited = await post("content", f.content.key, "draft.ratefixture", draft(f));
    expect(limited.status).toBe(429);
    expect(limited.body.code).toBe("public_rate_limited");
    expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
    const other = await fixture();
    await post("content", other.content.key, "draft.isolated", draft(other)).expect(201);
    const second = await f.keys.create(f.orgId, f.userId, {
        name: "Second",
        scope: "content:create",
      }),
      third = await f.keys.create(f.orgId, f.userId, { name: "Third", scope: "content:create" });
    for (let i = 0; i < 30; i++)
      await post("content", second.key, "draft.ratefixture", draft(f)).expect(201);
    await post("content", third.key, "draft.ratefixture", draft(f)).expect(429);
  });
  it("fails closed on native locked limiter buckets and exhausted dedicated pool without domain writes", async () => {
    const f = await fixture();
    const bucket = `v2:write:key:${createHash("sha256").update(`${f.orgId}:${f.content.id}`).digest("hex")}`;
    await connection.pool.query("INSERT INTO api_request_limits VALUES ($1,0,$2)", [
      bucket,
      Date.now() + 60000,
    ]);
    const lock = await connection.pool.connect();
    await lock.query("BEGIN");
    await lock.query("SELECT key FROM api_request_limits WHERE key=$1 FOR UPDATE", [bucket]);
    try {
      const t = Date.now();
      const response = await post("content", f.content.key, "draft.blocked", draft(f));
      expect(response.status).toBe(503);
      expect(Date.now() - t).toBeLessThan(3500);
      expect(await facts(f.orgId)).toMatchObject({ operations: 0, content: 0 });
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
    }
    // biome-ignore lint/complexity/useLiteralKeys: Native test exhausts the owned private pool, without a production test hook.
    const first = await limiter["pool"].connect(),
      // biome-ignore lint/complexity/useLiteralKeys: Same owned private pool.
      second = await limiter["pool"].connect();
    try {
      const t = Date.now();
      await post("content", f.content.key, "draft.poolblocked", draft(f)).expect(503);
      expect(Date.now() - t).toBeLessThan(3500);
    } finally {
      first.release();
      second.release();
    }
  });
  it("bounded cleanup preserves active counters and lifetime operation records", async () => {
    const prefix = `cleanup-${randomUUID()}`;
    await connection.pool.query(
      "INSERT INTO api_request_limits(key,points,expire) SELECT $1||n,1,0 FROM generate_series(1,1005)n",
      [prefix],
    );
    await connection.pool.query("INSERT INTO api_request_limits VALUES ($1,1,$2)", [
      `${prefix}-active`,
      Date.now() + 60000,
    ]);
    await limiter.cleanExpired();
    const remaining = await connection.pool.query(
      "SELECT count(*)::int AS n FROM api_request_limits WHERE key LIKE $1",
      [`${prefix}%`],
    );
    expect(remaining.rows[0].n).toBe(6);
    await connection.pool.query("DELETE FROM api_request_limits WHERE key LIKE $1", [`${prefix}%`]);
  });
});
