import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { schema } from "@pubrick/db";
import { encryptJson } from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
describe.skipIf(!url)("own Telegram two-phase binding on native PostgreSQL", () => {
  let app: NestExpressApplication;
  let db: typeof import("../db")["db"];
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "synthetic-telegram-binding-session-secret";
    process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 17).toString("base64");
    db = (await import("../db")).db;
    const { AppModule } = await import("../app.module");
    const { installTelegramWebhookParser } = await import("./telegram-webhook-parser");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
    installTelegramWebhookParser(app);
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  });
  afterAll(async () => {
    await app?.close();
  });
  async function account() {
    const agent = request.agent(app.getHttpServer());
    const suffix = randomUUID();
    const signup = await agent
      .post("/api/auth/sign-up/email")
      .send({
        email: `binding-${suffix}@example.invalid`,
        password: "synthetic-password123",
        name: "Synthetic Human",
      })
      .expect(200);
    return { agent, userId: signup.body.user.id as string };
  }
  async function fixture() {
    const owner = await account();
    const suffix = randomUUID();
    const org = await owner.agent
      .post("/api/auth/organization/create")
      .send({ name: "Synthetic binding workspace", slug: `binding-${suffix}` })
      .expect(200);
    const orgId = org.body.id as string;
    await owner.agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    const routeId = randomBytes(32).toString("base64url");
    const secret = randomBytes(32).toString("base64url");
    const [bot] = await db
      .insert(schema.telegramBotIdentities)
      .values({
        botId: String(BigInt(`0x${randomBytes(6).toString("hex")}`) + 1n),
        ownerOrgId: orgId,
        enabled: true,
      })
      .returning({ id: schema.telegramBotIdentities.id });
    if (!bot) throw new Error("Synthetic bot fixture was not created");
    await db.insert(schema.telegramDecisionConfigs).values({
      orgId,
      botIdentityId: bot.id,
      state: "active",
      routeId,
      secretHash: digest(secret),
      credentialsEncrypted: encryptJson(
        { token: "synthetic-unused-token" },
        process.env.APP_ENCRYPTION_KEY as string,
      ),
      retryPayloadEncrypted: encryptJson(
        { botUsername: "SyntheticBindingBot" },
        process.env.APP_ENCRYPTION_KEY as string,
      ),
    });
    async function member(role = "member") {
      const other = await account();
      await db
        .insert(schema.member)
        .values({ id: randomUUID(), organizationId: orgId, userId: other.userId, role });
      await other.agent
        .post("/api/auth/organization/set-active")
        .send({ organizationId: orgId })
        .expect(200);
      return other;
    }
    async function challenge(agent = owner.agent) {
      const result = await agent
        .post("/api/notifications/telegram-binding/challenge")
        .send({})
        .expect(200);
      const code = new URL(result.body.startUrl as string).searchParams.get("start");
      return { id: result.body.challengeId as string, code };
    }
    async function start(code: string | null, id = 42, updateId = 100) {
      return request(app.getHttpServer())
        .post(`/api/telegram/webhook/${routeId}`)
        .set("x-telegram-bot-api-secret-token", secret)
        .send({
          update_id: updateId,
          message: {
            message_id: updateId,
            text: `/start ${code}`,
            from: { id, is_bot: false, first_name: "<Synthetic>" },
            chat: { id, type: "private" },
          },
        });
    }
    return { ...owner, orgId, botId: bot.id, routeId, secret, member, challenge, start };
  }
  it("keeps setup and own binding status isolated across workspaces and users", async () => {
    const f = await fixture();
    const challenge = await f.challenge();
    await f.start(challenge.code).then((response) => expect(response.status).toBe(200));
    const own = await f.agent.get("/api/notifications/telegram-binding").expect(200);
    expect(own.body).toMatchObject({
      state: "awaiting_web_confirmation",
      challengeId: challenge.id,
      candidate: { telegramUserId: "42" },
    });
    const colleague = await f.member();
    const colleagueStatus = await colleague.agent
      .get("/api/notifications/telegram-binding")
      .expect(200);
    expect(colleagueStatus.body).toMatchObject({
      challengeId: null,
      bindingId: null,
      candidate: null,
    });
    const outsider = await account();
    const outsiderOrg = await outsider.agent
      .post("/api/auth/organization/create")
      .send({
        name: "Unrelated status workspace",
        slug: `status-${randomUUID()}`,
      })
      .expect(200);
    await outsider.agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: outsiderOrg.body.id })
      .expect(200);
    const foreignSetup = await outsider.agent
      .get("/api/notifications/telegram-decisions")
      .set("x-org-id", f.orgId)
      .query({ orgId: f.orgId })
      .expect(200);
    expect(foreignSetup.body).toMatchObject({ state: "disabled", hasCredentials: false });
    const foreignBinding = await outsider.agent
      .get("/api/notifications/telegram-binding")
      .set("x-org-id", f.orgId)
      .query({ orgId: f.orgId })
      .expect(200);
    expect(foreignBinding.body).toMatchObject({
      challengeId: null,
      bindingId: null,
      candidate: null,
    });
    expect(
      (await f.agent.get("/api/notifications/telegram-decisions").expect(200)).body.state,
    ).toBe("active");
  });
  it("requires a real original user's confirmation after Telegram claim and permits ordinary members/editors", async () => {
    const f = await fixture();
    const member = await f.member("editor");
    const other = await f.member();
    const challenge = await f.challenge(member.agent);
    await f.start(challenge.code).then((response) => expect(response.status).toBe(200));
    const claimed = await member.agent.get("/api/notifications/telegram-binding").expect(200);
    expect(claimed.body).toMatchObject({
      state: "awaiting_web_confirmation",
      bindingId: null,
      candidate: { telegramUserId: "42", displayName: "<Synthetic>" },
    });
    await other.agent
      .post("/api/notifications/telegram-binding/confirm")
      .send({ challengeId: challenge.id })
      .expect(409);
    await member.agent
      .post("/api/notifications/telegram-binding/confirm")
      .send({ challengeId: challenge.id })
      .expect(200)
      .then((response) => expect(response.body.state).toBe("linked"));
    await member.agent
      .delete("/api/notifications/telegram-binding")
      .expect(200)
      .then((response) => expect(response.body.state).toBe("revoked"));
    await member.agent
      .post("/api/notifications/telegram-binding/confirm")
      .send({ challengeId: challenge.id })
      .expect(409);
    await member.agent.get("/api/notifications").expect(403);
  });
  it("holds the first candidate, admits matching replay once and refuses mismatched update replay", async () => {
    const f = await fixture();
    const challenge = await f.challenge();
    await f.start(challenge.code).then((response) => expect(response.status).toBe(200));
    await f.start(challenge.code).then((response) => expect(response.status).toBe(200));
    await f.start(challenge.code, 43, 101).then((response) => expect(response.status).toBe(200));
    await f.start(challenge.code, 43, 100).then((response) => expect(response.status).toBe(409));
    const receipts = await db
      .select({ outcome: schema.telegramUpdateReceipts.outcome })
      .from(schema.telegramUpdateReceipts)
      .where(eq(schema.telegramUpdateReceipts.orgId, f.orgId));
    expect(receipts.map((row) => row.outcome).sort()).toEqual(["accepted", "refused"]);
    await f.agent
      .get("/api/notifications/telegram-binding")
      .expect(200)
      .then((response) => expect(response.body.candidate.telegramUserId).toBe("42"));
  });
  it("enforces atomic user issuance quota and removes expired candidate metadata opportunistically", async () => {
    const f = await fixture();
    const issued = await Promise.all(
      Array.from({ length: 6 }, () =>
        f.agent.post("/api/notifications/telegram-binding/challenge").send({}),
      ),
    );
    expect(issued.filter((response) => response.status === 200)).toHaveLength(5);
    expect(issued.filter((response) => response.status === 429)).toHaveLength(1);
    const issuedChallenge = issued.find((response) => response.status === 200);
    await f
      .start(new URL(issuedChallenge?.body.startUrl as string).searchParams.get("start"))
      .then((response) => expect(response.status).toBe(200));
    const id = randomUUID();
    await db.insert(schema.telegramBindingChallenges).values({
      id,
      orgId: f.orgId,
      userId: f.userId,
      botIdentityId: f.botId,
      generation: 1,
      codeHash: digest(randomBytes(32).toString("base64url")),
      state: "awaiting_web_confirmation",
      candidateTelegramUserId: "84001",
      candidateChatId: "84001",
      candidateDisplayName: "Synthetic aged candidate",
      createdAt: sql`statement_timestamp() - interval '2 days'`,
      claimedAt: sql`statement_timestamp() - interval '2 days' + interval '1 minute'`,
      expiresAt: sql`statement_timestamp() - interval '2 days' + interval '5 minutes'`,
    });
    await f.agent.get("/api/notifications/telegram-binding").expect(200);
    const old = await db
      .select({ id: schema.telegramBindingChallenges.id })
      .from(schema.telegramBindingChallenges)
      .where(eq(schema.telegramBindingChallenges.id, id));
    expect(old).toEqual([]);
  });
  it("authenticates headers before JSON parsing and limits raw bytes, with no unsupported journal", async () => {
    const f = await fixture();
    await request(app.getHttpServer())
      .post(`/api/telegram/webhook/${f.routeId}`)
      .set("Content-Type", "application/json")
      .send("{invalid")
      .expect(401);
    await request(app.getHttpServer())
      .post(`/api/telegram/webhook/${f.routeId}`)
      .set("x-telegram-bot-api-secret-token", f.secret)
      .set("Content-Type", "application/json")
      .send(`{"text":"${"x".repeat(65536)}"}`)
      .expect(413);
    await request(app.getHttpServer())
      .post(`/api/telegram/webhook/${f.routeId}`)
      .set("x-telegram-bot-api-secret-token", f.secret)
      .send({ update_id: 8, callback_query: { data: "unsupported" } })
      .expect(200);
    const receipts = await db
      .select({ id: schema.telegramUpdateReceipts.id })
      .from(schema.telegramUpdateReceipts)
      .where(eq(schema.telegramUpdateReceipts.orgId, f.orgId));
    expect(receipts).toEqual([]);
  });
  it("acknowledges group and bot starts without a journal or candidate mutation", async () => {
    const f = await fixture();
    const challenge = await f.challenge();
    for (const context of [
      { type: "group", isBot: false },
      { type: "supergroup", isBot: false },
      { type: "channel", isBot: false },
      { type: "private", isBot: true },
    ]) {
      await request(app.getHttpServer())
        .post(`/api/telegram/webhook/${f.routeId}`)
        .set("x-telegram-bot-api-secret-token", f.secret)
        .send({
          update_id: 800,
          message: {
            message_id: 801,
            text: `/start ${challenge.code}`,
            from: {
              id: Number.MAX_SAFE_INTEGER + 1,
              is_bot: context.isBot,
              first_name: "Synthetic",
            },
            chat: { id: -42, type: context.type },
          },
        })
        .expect(200);
    }
    const receipts = await db
      .select({ id: schema.telegramUpdateReceipts.id })
      .from(schema.telegramUpdateReceipts)
      .where(eq(schema.telegramUpdateReceipts.orgId, f.orgId));
    expect(receipts).toEqual([]);
    const [row] = await db
      .select({
        state: schema.telegramBindingChallenges.state,
        candidate: schema.telegramBindingChallenges.candidateTelegramUserId,
      })
      .from(schema.telegramBindingChallenges)
      .where(eq(schema.telegramBindingChallenges.id, challenge.id));
    expect(row).toEqual({ state: "awaiting_telegram", candidate: null });
    await request(app.getHttpServer())
      .post(`/api/telegram/webhook/${f.routeId}`)
      .set("x-telegram-bot-api-secret-token", f.secret)
      .send({
        update_id: 802,
        message: {
          message_id: 803,
          text: `/start ${challenge.code}`,
          from: { id: Number.MAX_SAFE_INTEGER + 1, is_bot: false },
          chat: { id: 42, type: "private" },
        },
      })
      .expect(400);
    const after = await db
      .select({ id: schema.telegramUpdateReceipts.id })
      .from(schema.telegramUpdateReceipts)
      .where(eq(schema.telegramUpdateReceipts.orgId, f.orgId));
    expect(after).toEqual([]);
  });
  it("requires unlink before replacing an active Telegram identity", async () => {
    const f = await fixture();
    const first = await f.challenge();
    await f.start(first.code).then((response) => expect(response.status).toBe(200));
    await f.agent
      .post("/api/notifications/telegram-binding/confirm")
      .send({ challengeId: first.id })
      .expect(200);
    const member = await f.member();
    const second = await f.challenge(member.agent);
    await f.start(second.code, 42, 102).then((response) => expect(response.status).toBe(200));
    await member.agent
      .post("/api/notifications/telegram-binding/confirm")
      .send({ challengeId: second.id })
      .expect(409);
    await f.agent.delete("/api/notifications/telegram-binding").expect(200);
    await member.agent
      .post("/api/notifications/telegram-binding/confirm")
      .send({ challengeId: second.id })
      .expect(200);
  });
  it("returns 503 at the update quota without claiming or recording an accepted receipt", async () => {
    const f = await fixture();
    const challenge = await f.challenge();
    await db.execute(sql`INSERT INTO telegram_update_receipts (org_id, bot_identity_id, update_id, generation, request_fingerprint, operation, outcome)
      SELECT ${f.orgId}, ${f.botId}::uuid, series::text, 1, ${"a".repeat(64)}, 'binding_start', 'refused'
      FROM generate_series(1000,10999) series`);
    await f.start(challenge.code).then((response) => expect(response.status).toBe(503));
    const [row] = await db
      .select({
        state: schema.telegramBindingChallenges.state,
        candidate: schema.telegramBindingChallenges.candidateTelegramUserId,
      })
      .from(schema.telegramBindingChallenges)
      .where(eq(schema.telegramBindingChallenges.id, challenge.id));
    expect(row).toEqual({ state: "awaiting_telegram", candidate: null });
    const [count] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.telegramUpdateReceipts)
      .where(eq(schema.telegramUpdateReceipts.orgId, f.orgId));
    expect(count?.count).toBe(10000);
  });
  it("refuses confirmation after membership removal or bot revocation", async () => {
    const f = await fixture();
    const member = await f.member();
    const challenge = await f.challenge(member.agent);
    await f.start(challenge.code).then((response) => expect(response.status).toBe(200));
    await db
      .delete(schema.member)
      .where(
        and(eq(schema.member.organizationId, f.orgId), eq(schema.member.userId, member.userId)),
      );
    await member.agent
      .post("/api/notifications/telegram-binding/confirm")
      .send({ challengeId: challenge.id })
      .expect(403);
    const own = await f.challenge();
    await f.start(own.code, 43, 200).then((response) => expect(response.status).toBe(200));
    await db
      .update(schema.telegramBotIdentities)
      .set({ enabled: false })
      .where(eq(schema.telegramBotIdentities.id, f.botId));
    await f.agent
      .post("/api/notifications/telegram-binding/confirm")
      .send({ challengeId: own.id })
      .expect(409);
  });
  it.each(["claim", "confirm"] as const)(
    "refuses an originally expired challenge at %s",
    async (phase) => {
      const f = await fixture();
      const code = randomBytes(32).toString("base64url");
      const id = randomUUID();
      await db.insert(schema.telegramBindingChallenges).values({
        id,
        orgId: f.orgId,
        userId: f.userId,
        botIdentityId: f.botId,
        generation: 1,
        codeHash: digest(code),
        createdAt: sql`statement_timestamp() - interval '6 minutes'`,
        expiresAt: sql`statement_timestamp() - interval '1 minute'`,
        ...(phase === "confirm"
          ? {
              state: "awaiting_web_confirmation" as const,
              candidateTelegramUserId: "42",
              candidateChatId: "42",
              candidateDisplayName: "Synthetic expired candidate",
              claimedAt: sql`statement_timestamp() - interval '5 minutes'`,
            }
          : {}),
      });
      if (phase === "claim")
        await f.start(code).then((response) => expect(response.status).toBe(200));
      else
        await f.agent
          .post("/api/notifications/telegram-binding/confirm")
          .send({ challengeId: id })
          .expect(409);
      const [challenge] = await db
        .select({
          state: schema.telegramBindingChallenges.state,
          candidate: schema.telegramBindingChallenges.candidateTelegramUserId,
        })
        .from(schema.telegramBindingChallenges)
        .where(eq(schema.telegramBindingChallenges.id, id));
      // Confirm's failed transaction rolls cleanup back; neither phase binds.
      expect(challenge?.state).toBe(phase === "claim" ? "expired" : "awaiting_web_confirmation");
      expect(challenge?.candidate).toBe(phase === "claim" ? null : "42");
      const bindings = await db
        .select({ id: schema.telegramBindings.id })
        .from(schema.telegramBindings)
        .where(eq(schema.telegramBindings.orgId, f.orgId));
      expect(bindings).toEqual([]);
      const receipts = await db
        .select({ outcome: schema.telegramUpdateReceipts.outcome })
        .from(schema.telegramUpdateReceipts)
        .where(eq(schema.telegramUpdateReceipts.orgId, f.orgId));
      expect(receipts).toEqual(phase === "claim" ? [{ outcome: "refused" }] : []);
    },
  );
  it("serializes real concurrent confirm and unlink after observing both organization waits", async () => {
    const f = await fixture();
    const challenge = await f.challenge();
    await f.start(challenge.code).then((response) => expect(response.status).toBe(200));
    if (!url || !/^pubrick_[a-zA-Z0-9_]+_test$/.test(new URL(url).pathname.slice(1)))
      throw new Error("Binding lock proof requires a disposable pubrick_*_test database");
    const writer = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    const observer = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    let pending: Promise<request.Response>[] = [];
    let committed = false;
    let transactionStarted = false;
    try {
      await writer.connect();
      await observer.connect();
      const { rows } = await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const writerPid = rows[0]?.pid;
      if (!writerPid) throw new Error("Missing organization barrier PID");
      await writer.query("BEGIN");
      transactionStarted = true;
      await writer.query("SELECT id FROM organization WHERE id=$1 FOR UPDATE", [f.orgId]);
      pending = [
        f.agent
          .post("/api/notifications/telegram-binding/confirm")
          .send({ challengeId: challenge.id })
          .then((response) => response),
        f.agent.delete("/api/notifications/telegram-binding").then((response) => response),
      ];
      await expect
        .poll(
          async () => {
            const blocked = await observer.query<{ count: number }>(
              // A second tuple waiter can queue behind the first waiter, not
              // directly behind the barrier. Follow the real blocking chain.
              `WITH RECURSIVE waits AS (
                SELECT pid, unnest(pg_blocking_pids(pid)) AS blocker, ARRAY[pid] AS visited
                FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
                UNION ALL
                SELECT waits.pid, unnest(pg_blocking_pids(waits.blocker)), visited || waits.blocker
                FROM waits WHERE NOT waits.blocker = ANY(visited)
              ) SELECT count(DISTINCT waits.pid)::int AS count FROM waits
              JOIN pg_stat_activity activity ON activity.pid=waits.pid
              WHERE waits.blocker=$1::int AND activity.query LIKE '%organization%'`,
              [writerPid],
            );
            return blocked.rows[0]?.count;
          },
          { timeout: 5000, interval: 25 },
        )
        .toBe(2);
      await writer.query("COMMIT");
      committed = true;
      const [confirmed, unlinked] = await Promise.all(pending);
      expect([200, 409]).toContain(confirmed?.status);
      expect(unlinked?.status).toBe(200);
      const bindings = await db
        .select({ state: schema.telegramBindings.state })
        .from(schema.telegramBindings)
        .where(eq(schema.telegramBindings.orgId, f.orgId));
      expect(bindings.every((row) => row.state === "revoked")).toBe(true);
      expect(bindings).toHaveLength(confirmed?.status === 200 ? 1 : 0);
      const [terminal] = await db
        .select({
          state: schema.telegramBindingChallenges.state,
          terminalAt: schema.telegramBindingChallenges.terminalAt,
        })
        .from(schema.telegramBindingChallenges)
        .where(eq(schema.telegramBindingChallenges.id, challenge.id));
      expect(terminal?.state).toBe(confirmed?.status === 200 ? "consumed" : "revoked");
      expect(terminal?.terminalAt).toBeInstanceOf(Date);
      expect(
        (await f.agent.get("/api/notifications/telegram-binding").expect(200)).body.state,
      ).toBe("revoked");
    } finally {
      try {
        if (transactionStarted && !committed) await writer.query("ROLLBACK");
      } finally {
        try {
          await Promise.allSettled(pending);
        } finally {
          try {
            await observer.end();
          } finally {
            await writer.end();
          }
        }
      }
    }
  });
  it("admits only one of two issuances at the organization's hundred-challenge capacity", async () => {
    const f = await fixture();
    const seedActor = await f.member();
    await db.execute(sql`INSERT INTO telegram_binding_challenges
      (org_id,user_id,bot_identity_id,generation,code_hash,created_at,expires_at)
      SELECT ${f.orgId},${seedActor.userId},${f.botId}::uuid,1,
        md5(${randomUUID()} || series::text) || md5(${randomUUID()} || series::text),
        statement_timestamp(),statement_timestamp()+interval '5 minutes' FROM generate_series(1,99) series`);
    const responses = await Promise.all(
      Array.from({ length: 2 }, () =>
        f.agent.post("/api/notifications/telegram-binding/challenge").send({}),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 429]);
    const [count] = await db
      .select({
        total: sql<number>`count(*)::int`,
        own: sql<number>`count(*) filter(where user_id=${f.userId})::int`,
      })
      .from(schema.telegramBindingChallenges)
      .where(eq(schema.telegramBindingChallenges.orgId, f.orgId));
    expect(count).toEqual({ total: 100, own: 1 });
  });
  it("admits one fresh supported update at 9999 and records no over-capacity receipt", async () => {
    const f = await fixture();
    const challenge = await f.challenge();
    await db.execute(sql`INSERT INTO telegram_update_receipts
      (org_id,bot_identity_id,update_id,generation,request_fingerprint,operation,outcome)
      SELECT ${f.orgId},${f.botId}::uuid,series::text,1,${"a".repeat(64)},'binding_start','refused'
      FROM generate_series(1000,10998) series`);
    const responses = await Promise.all([
      f.start(challenge.code, 42, 100),
      f.start(challenge.code, 43, 101),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 503]);
    const acceptedIndex = responses.findIndex((response) => response.status === 200);
    const [count] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.telegramUpdateReceipts)
      .where(eq(schema.telegramUpdateReceipts.orgId, f.orgId));
    expect(count?.count).toBe(10000);
    const fresh = await db
      .select({
        updateId: schema.telegramUpdateReceipts.updateId,
        outcome: schema.telegramUpdateReceipts.outcome,
      })
      .from(schema.telegramUpdateReceipts)
      .where(
        and(
          eq(schema.telegramUpdateReceipts.orgId, f.orgId),
          sql`${schema.telegramUpdateReceipts.updateId} IN ('100','101')`,
        ),
      );
    expect(fresh).toEqual([{ updateId: String(100 + acceptedIndex), outcome: "accepted" }]);
    const [candidate] = await db
      .select({
        state: schema.telegramBindingChallenges.state,
        candidate: schema.telegramBindingChallenges.candidateTelegramUserId,
      })
      .from(schema.telegramBindingChallenges)
      .where(eq(schema.telegramBindingChallenges.id, challenge.id));
    expect(candidate).toEqual({
      state: "awaiting_web_confirmation",
      candidate: String(42 + acceptedIndex),
    });
  });
  it("excludes a challenge just beyond the database ten-minute window and counts fresh admission", async () => {
    const f = await fixture();
    // Start outside the boundary using the database clock; later HTTP time can
    // only move this row further outside. No wall-clock sleeps or immutable UPDATE.
    await db.execute(sql`INSERT INTO telegram_binding_challenges
      (org_id,user_id,bot_identity_id,generation,code_hash,created_at,expires_at,state,terminal_at)
      VALUES(${f.orgId},${f.userId},${f.botId}::uuid,1,${digest(randomBytes(32).toString("base64url"))},
        statement_timestamp()-interval '10 minutes 0.000001 seconds',statement_timestamp()-interval '5 minutes 0.000001 seconds',
        'expired',statement_timestamp()-interval '5 minutes 0.000001 seconds')`);
    await db.execute(sql`INSERT INTO telegram_binding_challenges
      (org_id,user_id,bot_identity_id,generation,code_hash,created_at,expires_at)
      SELECT ${f.orgId},${f.userId},${f.botId}::uuid,1,
        md5(${randomUUID()} || series::text) || md5(${randomUUID()} || series::text),
        statement_timestamp()-interval '1 minute',statement_timestamp()+interval '4 minutes'
      FROM generate_series(1,4) series`);
    await f.agent.post("/api/notifications/telegram-binding/challenge").send({}).expect(200);
    await f.agent.post("/api/notifications/telegram-binding/challenge").send({}).expect(429);
    const [count] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(schema.telegramBindingChallenges)
      .where(eq(schema.telegramBindingChallenges.orgId, f.orgId));
    expect(count?.total).toBe(6);
  });
});
