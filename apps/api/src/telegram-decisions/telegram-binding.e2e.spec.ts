import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { schema } from "@pubrick/db";
import { encryptJson } from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
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
});
