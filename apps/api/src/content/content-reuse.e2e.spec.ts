import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, runMigrations, schema } from "@pubrick/db";
import {
  encryptJson,
  MAX_CONTENT_REUSE_OPERATIONS,
  PAID_GENERATION_CONSENT_VERSION,
} from "@pubrick/shared";
import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const parentUrl = process.env.TEST_DATABASE_URL;
const keyRing = "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
describe.skipIf(!parentUrl)("native saved-content reuse admission", () => {
  let app: INestApplication;
  let connection: ReturnType<typeof createDb>;
  let runtimePool: ReturnType<typeof createDb>["pool"] | undefined;
  let ownedName: string | undefined;
  let ownedUrl: string;
  const priorUrl = process.env.DATABASE_URL;
  beforeAll(async () => {
    const parent = new URL(parentUrl as string);
    if (
      !/^postgres(?:ql)?:$/.test(parent.protocol) ||
      !["127.0.0.1", "localhost"].includes(parent.hostname) ||
      !/^pubrick(?:_[a-z0-9]+)*_test$/.test(parent.pathname.slice(1))
    )
      throw new Error("Reuse tests require an owned loopback disposable pubrick_*_test database");
    const name = `pubrick_reuse_${randomUUID().replaceAll("-", "")}_test`;
    const admin = createDb(parent.toString());
    try {
      await admin.pool.query(`CREATE DATABASE "${name}"`);
      ownedName = name;
    } finally {
      await admin.pool.end();
    }
    parent.pathname = `/${name}`;
    ownedUrl = parent.toString();
    await runMigrations(ownedUrl);
    process.env.DATABASE_URL = ownedUrl;
    process.env.BETTER_AUTH_SECRET = "synthetic-reuse-native-secret";
    process.env.APP_ENCRYPTION_KEY = keyRing;
    const { AppModule } = await import("../app.module");
    runtimePool = (await import("../db")).pool;
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix("api");
    await app.init();
    connection = createDb(ownedUrl);
  });
  async function dropOwnedDatabase() {
    if (!ownedName) return;
    if (!/^pubrick_reuse_[a-f0-9]{32}_test$/.test(ownedName))
      throw new Error("Unsafe owned database name");
    const admin = createDb(parentUrl as string);
    try {
      await admin.pool.query(`DROP DATABASE "${ownedName}" WITH (FORCE)`);
    } finally {
      await admin.pool.end();
    }
  }
  afterAll(async () => {
    const results = await Promise.allSettled([
      app?.close(),
      connection?.pool.end(),
      runtimePool?.end(),
    ]);
    if (priorUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorUrl;
    await dropOwnedDatabase();
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((result) => result.reason),
        "Owned reuse fixture cleanup failed",
      );
  });
  async function fixture() {
    const agent = request.agent(app.getHttpServer());
    const signup = await agent
      .post("/api/auth/sign-up/email")
      .send({
        name: "Reuse fixture",
        email: `${randomUUID()}@example.test`,
        password: "synthetic-password-long",
      })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: "Reuse fixture", slug: randomUUID() })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    const orgId = org.body.id as string;
    const [brand] = await connection.db
      .insert(schema.brands)
      .values({ orgId, name: "Reuse fixture" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("Missing fixture brand");
    const [channel] = await connection.db
      .insert(schema.channels)
      .values({ orgId, brandId: brand.id, name: "Manual", platform: "vc_ru" })
      .returning({ id: schema.channels.id });
    const [source] = await connection.db
      .insert(schema.contentItems)
      .values({
        orgId,
        brandId: brand.id,
        body: "Saved master.\nSecond sentence.",
        title: "Saved title",
        origin: "human",
      })
      .returning({ id: schema.contentItems.id });
    if (!source || !channel) throw new Error("Missing fixture source/channel");
    await connection.db.insert(schema.aiCredentials).values({
      orgId,
      provider: "openai",
      credentialsEncrypted: encryptJson({ apiKey: "synthetic-never-dispatched" }, keyRing),
      defaultModel: "gpt-5.4",
    });

    return {
      agent,
      orgId,
      userId: signup.body.user.id as string,
      brandId: brand.id,
      channelId: channel.id,
      sourceId: source.id,
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  async function body(f: Fixture) {
    const preview = await f.agent.get(`/api/content/${f.sourceId}/reuse-source`).expect(200);
    return {
      expectedSourceRevision: preview.body.bodyRevision,
      expectedSourceDigest: preview.body.digest,
      channelIds: [f.channelId],
      contentType: "social_post",
      brief: "New audience",
      allowPaidGeneration: true,
      consentVersion: PAID_GENERATION_CONSENT_VERSION,
    };
  }
  function post(f: Fixture, key: string, value: object, target = f.sourceId) {
    return f.agent.post(`/api/content/${target}/reuse`).set("Idempotency-Key", key).send(value);
  }
  async function facts(f: Fixture) {
    const result = await connection.db.execute(sql`select
      (select count(*)::int from content_reuse_operations where org_id=${f.orgId}) operations,
      (select count(*)::int from run_source_lineage where org_id=${f.orgId}) lineage,
      (select count(*)::int from pipeline_runs where org_id=${f.orgId}) runs,
      (select count(*)::int from pgboss.job where name='generate' and data->>'orgId'=${f.orgId}) jobs`);
    return result.rows[0];
  }
  it("concurrent confirmed requests commit exactly one run, lineage, operation and ID-only real job", async () => {
    const f = await fixture();
    const value = await body(f);
    const replies = await Promise.all(
      Array.from({ length: 6 }, () => post(f, "same-operation-1", value)),
    );
    expect(replies.map((reply) => reply.status)).toEqual(Array(6).fill(201));
    expect(new Set(replies.map((reply) => reply.body.id)).size).toBe(1);
    expect(await facts(f)).toEqual({ operations: 1, lineage: 1, runs: 1, jobs: 1 });
    const jobs = await connection.pool.query(
      "select data from pgboss.job where name='generate' and data->>'orgId'=$1",
      [f.orgId],
    );
    expect(jobs.rows.map((row) => row.data)).toEqual([
      { runId: replies[0]?.body.id, orgId: f.orgId },
    ]);
    expect(
      await post(f, "same-operation-1", { ...value, brief: "Changed instructions" }),
    ).toMatchObject({ status: 409, body: { code: "idempotency_conflict" } });
  });
  it.each(["title", "body", "richBody"] as const)(
    "rejects stale %s evidence without durable work",
    async (field) => {
      const f = await fixture();
      const value = await body(f);
      await connection.db
        .update(schema.contentItems)
        .set(
          field === "title"
            ? { title: "Changed title" }
            : field === "body"
              ? { body: "Changed body", bodyRevision: 1 }
              : { richBody: { type: "doc", content: [] }, bodyRevision: 1 },
        )
        .where(eq(schema.contentItems.id, f.sourceId));
      expect(await post(f, `stale-${field}-operation`, value)).toMatchObject({
        status: 409,
        body: { code: "reuse_source_changed" },
      });
      expect(await facts(f)).toEqual({ operations: 0, lineage: 0, runs: 0, jobs: 0 });
    },
  );
  it("treats uppercase path UUIDs as the same resource during first admission and replay", async () => {
    const f = await fixture();
    const value = await body(f);
    const first = await post(f, "uppercase-operation-key", value, f.sourceId.toUpperCase()).expect(
      201,
    );
    expect((await post(f, "uppercase-operation-key", value).expect(201)).body).toEqual(first.body);
    expect(
      (await post(f, "uppercase-operation-key", value, f.sourceId.toUpperCase()).expect(201)).body,
    ).toEqual(first.body);
    expect(await facts(f)).toEqual({ operations: 1, lineage: 1, runs: 1, jobs: 1 });
  });
  it("replays after source and AI deletion, rejects changed path, then preserves missing-result tombstone", async () => {
    const f = await fixture();
    const value = await body(f);
    const first = await post(f, "recover-operation-1", value).expect(201);
    await connection.db.delete(schema.contentItems).where(eq(schema.contentItems.id, f.sourceId));
    await connection.db.delete(schema.aiCredentials).where(eq(schema.aiCredentials.orgId, f.orgId));
    expect((await post(f, "recover-operation-1", value).expect(201)).body).toEqual(first.body);
    expect(await post(f, "recover-operation-1", value, randomUUID())).toMatchObject({
      status: 409,
      body: { code: "idempotency_conflict" },
    });
    await connection.db
      .delete(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, first.body.id));
    expect(await post(f, "recover-operation-1", value)).toMatchObject({
      status: 410,
      body: { code: "public_result_gone" },
    });
    expect(await facts(f)).toEqual({ operations: 1, lineage: 0, runs: 0, jobs: 1 });
  });
  it("refuses ineligible, deleted-channel and foreign-tenant sources before admission", async () => {
    const f = await fixture();
    const other = await fixture();
    const value = await body(f);
    expect(await post(f, "foreign-operation-1", value, other.sourceId)).toMatchObject({
      status: 404,
    });
    await connection.db
      .update(schema.contentItems)
      .set({ status: "rejected" })
      .where(eq(schema.contentItems.id, f.sourceId));
    expect(await post(f, "ineligible-operation-1", value)).toMatchObject({
      status: 409,
      body: { code: "reuse_source_ineligible" },
    });
    await connection.db
      .update(schema.contentItems)
      .set({ status: "draft" })
      .where(eq(schema.contentItems.id, f.sourceId));
    await connection.db.delete(schema.channels).where(eq(schema.channels.id, f.channelId));
    expect(await post(f, "missing-channel-operation", value)).toMatchObject({ status: 400 });
    expect(await facts(f)).toEqual({ operations: 0, lineage: 0, runs: 0, jobs: 0 });
  });
  it("retries frozen accepted material with consent and replays after the original run is gone", async () => {
    const f = await fixture();
    const value = await body(f);
    const first = await post(f, "retry-source-operation", value).expect(201);
    const consent = { allowPaidGeneration: true, consentVersion: PAID_GENERATION_CONSENT_VERSION };
    expect((await f.agent.post(`/api/runs/${first.body.id}/retry`).send({})).status).toBe(400);
    await connection.db
      .update(schema.contentItems)
      .set({
        body: "New edited source",
        bodyRevision: 1,
        status: "archived",
        archivedFromStatus: "draft",
      })
      .where(eq(schema.contentItems.id, f.sourceId));
    const retry = () =>
      f.agent
        .post(`/api/runs/${first.body.id}/retry`)
        .set("Idempotency-Key", "retry-frozen-operation")
        .send(consent);
    const result = await retry().expect(201);
    const frozen = await connection.pool.query(
      "select r.input,l.source_revision,l.source_title,l.source_content_id from pipeline_runs r join run_source_lineage l on l.derived_run_id=r.id where r.id=$1",
      [result.body.id],
    );
    expect(frozen.rows[0]).toMatchObject({
      input: {
        kind: "source",
        material: "Saved master.\nSecond sentence.",
        text: "New audience",
        sourceUrl: null,
      },
      source_revision: 0,
      source_title: "Saved title",
      source_content_id: f.sourceId,
    });
    await connection.db
      .delete(schema.pipelineRuns)
      .where(eq(schema.pipelineRuns.id, first.body.id));
    expect((await retry().expect(201)).body).toEqual(result.body);
    expect(
      (
        await f.agent
          .post(`/api/runs/${randomUUID()}/retry`)
          .set("Idempotency-Key", "retry-frozen-operation")
          .send(consent)
      ).status,
    ).toBe(409);
    expect(await facts(f)).toEqual({ operations: 2, lineage: 1, runs: 1, jobs: 2 });
  });
  it("refuses replay when current brand grant or session authority is revoked", async () => {
    const f = await fixture();
    const value = await body(f);
    await post(f, "revoked-operation-key", value).expect(201);
    const members = await connection.pool.query(
      "select id from member where organization_id=$1 and user_id=$2",
      [f.orgId, f.userId],
    );
    await connection.pool.query(
      "update member set role='author' where organization_id=$1 and user_id=$2",
      [f.orgId, f.userId],
    );
    expect((await post(f, "revoked-operation-key", value)).status).toBe(404);
    await connection.db
      .insert(schema.brandAccess)
      .values({ orgId: f.orgId, brandId: f.brandId, memberId: members.rows[0].id });
    expect((await post(f, "revoked-operation-key", value)).status).toBe(201);
    await connection.pool.query(
      "update session set expires_at=now()-interval '1 minute' where user_id=$1",
      [f.userId],
    );
    expect([401, 403]).toContain((await post(f, "revoked-operation-key", value)).status);
    expect(await facts(f)).toEqual({ operations: 1, lineage: 1, runs: 1, jobs: 1 });
  });
  it("keeps replay available at the lifetime operation cap and refuses new paid work", async () => {
    const f = await fixture();
    const value = await body(f);
    const first = await post(f, "capacity-original-key", value).expect(201);
    await connection.pool.query(
      `insert into content_reuse_operations
      (org_id,brand_id,operation,idempotency_key,request_hash,hash_version,root_source_id,root_source_revision,
       request_target_kind,request_target_id,result_run_id,consenting_actor_id,consent_version)
      select $1,$2,'reuse','capacity-fixture-'||n,repeat('a',64),'parsed-dto-v1',$3,0,'content',$3,$4,$5,$6
      from generate_series(1,$7) n`,
      [
        f.orgId,
        f.brandId,
        f.sourceId,
        first.body.id,
        f.userId,
        PAID_GENERATION_CONSENT_VERSION,
        MAX_CONTENT_REUSE_OPERATIONS - 1,
      ],
    );
    expect((await post(f, "capacity-original-key", value).expect(201)).body).toEqual(first.body);
    expect(await post(f, "capacity-new-paid-key", value)).toMatchObject({
      status: 409,
      body: { code: "reuse_operation_limit" },
    });
    expect(await facts(f)).toEqual({
      operations: MAX_CONTENT_REUSE_OPERATIONS,
      lineage: 1,
      runs: 1,
      jobs: 1,
    });
  });
  it("observed native source-edit lock forces final CAS refusal and rolls back admission", async () => {
    const f = await fixture();
    const value = await body(f);
    const locker = await connection.pool.connect();
    await locker.query("begin");
    await locker.query("update content_items set title='Concurrent edited title' where id=$1", [
      f.sourceId,
    ]);
    const pending = post(f, "source-race-operation", value).then((response) => response);
    try {
      await expect
        .poll(
          async () => {
            const wait = await connection.pool.query(
              "select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query ilike '%content_items%' and query ilike '%for share%'",
            );
            return wait.rows[0].n;
          },
          { timeout: 5000 },
        )
        .toBeGreaterThan(0);
      await locker.query("commit");
      expect(await pending).toMatchObject({ status: 409, body: { code: "reuse_source_changed" } });
      expect(await facts(f)).toEqual({ operations: 0, lineage: 0, runs: 0, jobs: 0 });
    } finally {
      await locker.query("rollback");
      locker.release();
    }
  });
  it.each(["null", "throw"] as const)(
    "rolls back every durable row when actual queue send %s fails",
    async (failure) => {
      const f = await fixture();
      const value = await body(f);
      const { QueueService } = await import("../queue/queue.service");
      const queue = app.get(QueueService);
      // Test-only observation of the real transport boundary; retain enqueueGenerate's null guard.
      const boss = (
        queue as unknown as { boss: { send: (...args: unknown[]) => Promise<string | null> } }
      ).boss;
      const spy = vi.spyOn(boss, "send");
      if (failure === "null") spy.mockResolvedValueOnce(null);
      else spy.mockRejectedValueOnce(new Error("Synthetic durable queue failure"));
      try {
        expect((await post(f, `queue-${failure}-operation`, value)).status).toBe(
          failure === "null" ? 409 : 500,
        );
        expect(await facts(f)).toEqual({ operations: 0, lineage: 0, runs: 0, jobs: 0 });
      } finally {
        spy.mockRestore();
      }
    },
  );
});
