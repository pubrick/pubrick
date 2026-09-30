import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import { RUN_ADMISSION_LOCK_NAMESPACE } from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("hosted authority after real HTTP admission waits", () => {
  let app: INestApplication;
  let connection: ReturnType<typeof createDb>;
  const prior = {
    mode: process.env.PUBRICK_DEPLOYMENT_MODE,
    driver: process.env.BILLING_DRIVER,
    account: process.env.BILLING_ACCOUNT_ID,
  };
  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.PUBRICK_DEPLOYMENT_MODE = "self-hosted";
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const { AppModule } = await import("./app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    connection = createDb(url as string);
  });
  afterAll(async () => {
    await app?.close();
    await connection?.pool.end();
    for (const [key, value] of Object.entries({
      PUBRICK_DEPLOYMENT_MODE: prior.mode,
      BILLING_DRIVER: prior.driver,
      BILLING_ACCOUNT_ID: prior.account,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  async function fixture() {
    process.env.PUBRICK_DEPLOYMENT_MODE = "self-hosted";
    const agent = request.agent(app.getHttpServer());
    const signup = await agent
      .post("/api/auth/sign-up/email")
      .send({
        name: "Authority fixture",
        email: `${randomUUID()}@example.test`,
        password: "password-long-enough",
      })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: "Authority", slug: randomUUID() })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    const userId = signup.body.user.id as string;
    const orgId = org.body.id as string;
    await connection.db
      .update(schema.user)
      .set({ emailVerified: true })
      .where(eq(schema.user.id, userId));
    const [brand] = await connection.db
      .insert(schema.brands)
      .values({ orgId, name: "Authority brand" })
      .returning({ id: schema.brands.id });
    if (!brand) throw new Error("Missing fixture brand");
    process.env.PUBRICK_DEPLOYMENT_MODE = "hosted";
    process.env.BILLING_DRIVER = "fixture";
    process.env.BILLING_ACCOUNT_ID = "fixture_authority";
    const [channel] = await connection.db
      .insert(schema.channels)
      .values({ orgId, brandId: brand.id, name: "Authority manual", platform: "vc_ru" })
      .returning({ id: schema.channels.id });
    if (!channel) throw new Error("Missing fixture channel");
    return { agent, orgId, userId, brandId: brand.id, channelId: channel.id };
  }
  async function blocker(orgId: string): Promise<PoolClient> {
    const client = await connection.pool.connect();
    await client.query("BEGIN");
    await client.query("select pg_advisory_xact_lock($1,hashtext($2))", [
      RUN_ADMISSION_LOCK_NAMESPACE,
      orgId,
    ]);
    await client.query('select id from "organization" where id=$1 for update', [orgId]);
    return client;
  }
  async function waitForAdmission(orgId: string) {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const result = await connection.db.execute<{ count: string }>(
        sql`select count(*)::text as count from pg_locks where locktype='advisory' and classid=${RUN_ADMISSION_LOCK_NAMESPACE}::oid and objid=hashtext(${orgId})::oid and not granted`,
      );
      if (Number(result.rows[0]?.count) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Request did not reach actual advisory wait");
  }
  it.each(["remove", "downgrade", "expire", "unverify"] as const)(
    "refuses growth when %s commits after the guard but before admission",
    async (change) => {
      const f = await fixture();
      const lock = await blocker(f.orgId);
      let response: Promise<request.Response> | undefined;
      try {
        response = f.agent
          .post("/api/brands")
          .send({ name: "Must not appear" })
          .then((value) => value);
        await waitForAdmission(f.orgId);
        if (change === "remove")
          await lock.query('delete from "member" where organization_id=$1 and user_id=$2', [
            f.orgId,
            f.userId,
          ]);
        if (change === "downgrade")
          await lock.query(
            "update \"member\" set role='author' where organization_id=$1 and user_id=$2",
            [f.orgId, f.userId],
          );
        if (change === "expire")
          await lock.query(
            "update \"session\" set expires_at=now()-interval '1 second' where user_id=$1",
            [f.userId],
          );
        if (change === "unverify")
          await lock.query('update "user" set email_verified=false where id=$1', [f.userId]);
        await lock.query("COMMIT");
        expect((await response).status).toBe(403);
        const brands = await connection.db
          .select({ name: schema.brands.name })
          .from(schema.brands)
          .where(eq(schema.brands.orgId, f.orgId));
        expect(brands).toEqual([{ name: "Authority brand" }]);
      } finally {
        await lock.query("ROLLBACK");
        lock.release();
        await response;
      }
    },
  );
  it("refuses channel growth when its granted brand is revoked during the wait", async () => {
    const f = await fixture();
    await connection.db
      .update(schema.member)
      .set({ role: "member" })
      .where(and(eq(schema.member.organizationId, f.orgId), eq(schema.member.userId, f.userId)));
    const [member] = await connection.db
      .select({ id: schema.member.id })
      .from(schema.member)
      .where(and(eq(schema.member.organizationId, f.orgId), eq(schema.member.userId, f.userId)));
    if (!member) throw new Error("Missing fixture member");
    await connection.db
      .insert(schema.brandAccess)
      .values({ orgId: f.orgId, brandId: f.brandId, memberId: member.id });
    const lock = await blocker(f.orgId);
    let response: Promise<request.Response> | undefined;
    try {
      await lock.query("select id from brands where id=$1 for update", [f.brandId]);
      response = f.agent
        .post("/api/channels")
        .send({
          brandId: f.brandId,
          name: "Forbidden channel",
          platform: "telegram",
          credentials: { botToken: "fixture-token", chatId: "fixture-chat" },
        })
        .then((value) => value);
      await waitForAdmission(f.orgId);
      await lock.query("delete from brand_access where org_id=$1 and brand_id=$2", [
        f.orgId,
        f.brandId,
      ]);
      await lock.query("COMMIT");
      expect((await response).status).toBe(403);
      expect(
        await connection.db
          .select({ id: schema.channels.id })
          .from(schema.channels)
          .where(eq(schema.channels.orgId, f.orgId)),
      ).toEqual([{ id: f.channelId }]);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
      await response;
    }
  });
  it("refuses run admission after removal without inserting a pipeline row", async () => {
    const f = await fixture();
    const lock = await blocker(f.orgId);
    let response: Promise<request.Response> | undefined;
    try {
      response = f.agent
        .post("/api/runs")
        .send({ brandId: f.brandId, brief: "A bounded fixture article", channelIds: [f.channelId] })
        .then((value) => value);
      await waitForAdmission(f.orgId);
      await lock.query('delete from "member" where organization_id=$1 and user_id=$2', [
        f.orgId,
        f.userId,
      ]);
      await lock.query("COMMIT");
      expect((await response).status).toBe(403);
      expect(
        await connection.db
          .select({ id: schema.pipelineRuns.id })
          .from(schema.pipelineRuns)
          .where(eq(schema.pipelineRuns.orgId, f.orgId)),
      ).toHaveLength(0);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
      await response;
    }
  });
  it("rechecks the session actor before a physical probe after membership removal", async () => {
    const f = await fixture();
    const [session] = await connection.db
      .select({ id: schema.session.id })
      .from(schema.session)
      .where(
        and(eq(schema.session.userId, f.userId), eq(schema.session.activeOrganizationId, f.orgId)),
      );
    if (!session) throw new Error("Missing fixture session");
    const { runWithRequestAuthority } = await import("./request-authority");
    const { hostedAiCallScope, hostedAiRefusal } = await import("./hosted-ai-call");
    const lock = await blocker(f.orgId);
    const dispatch = vi.fn(async () => "local fixture response");
    const attempt = runWithRequestAuthority(
      Object.freeze({
        kind: "session",
        orgId: f.orgId,
        userId: f.userId,
        sessionId: session.id,
        scope: Object.freeze({ kind: "org", roles: "manager" }),
        capability: undefined,
        mutation: true,
        brandId: undefined,
        resourceId: undefined,
      }),
      async () => {
        try {
          return await hostedAiCallScope(f.orgId, "probe")?.(dispatch);
        } catch (error) {
          return error;
        }
      },
    );
    try {
      await waitForAdmission(f.orgId);
      await lock.query('delete from "member" where organization_id=$1 and user_id=$2', [
        f.orgId,
        f.userId,
      ]);
      await lock.query("COMMIT");
      expect(hostedAiRefusal(await attempt)?.code).toBe("authority_revoked");
      expect(dispatch).not.toHaveBeenCalled();
      expect(
        await connection.db
          .select({ id: schema.hostedAiCallLeases.id })
          .from(schema.hostedAiCallLeases)
          .where(eq(schema.hostedAiCallLeases.orgId, f.orgId)),
      ).toHaveLength(0);
    } finally {
      await lock.query("ROLLBACK");
      lock.release();
      await attempt;
    }
  });
  it("fails closed for missing authority before creating a probe lease", async () => {
    const f = await fixture();
    const { hostedAiCallScope, hostedAiRefusal } = await import("./hosted-ai-call");
    const dispatch = vi.fn(async () => "local fixture response");
    const error = await hostedAiCallScope(f.orgId, "probe")?.(dispatch).catch((value) => value);
    expect(hostedAiRefusal(error)?.code).toBe("authority_revoked");
    expect(dispatch).not.toHaveBeenCalled();
  });
});
