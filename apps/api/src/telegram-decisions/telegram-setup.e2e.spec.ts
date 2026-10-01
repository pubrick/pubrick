import { randomInt, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { schema } from "@pubrick/db";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const database = process.env.TEST_DATABASE_URL;
describe.skipIf(!database)("Telegram setup through real workspace sessions", () => {
  let server: Server;
  let app: NestExpressApplication;
  let db: typeof import("../db")["db"];
  const urls = new Map<string, string>();
  const unknown = new Set<string>();
  const mutations: Array<{ token: string; method: string; body: Record<string, unknown> }> = [];
  const tokens = new Map<string, number>();
  const barriers = new Map<string, { entered: () => void; released: Promise<void> }>();
  beforeAll(async () => {
    server = createServer(async (incoming, outgoing) => {
      const match = /^\/bot([^/]+)\/(getMe|getWebhookInfo|setWebhook|deleteWebhook)$/.exec(
        incoming.url ?? "",
      );
      if (!match?.[1] || !match[2]) {
        outgoing.writeHead(404).end();
        return;
      }
      const token = match[1],
        method = match[2];
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      const id = tokens.get(token);
      if (!id) {
        outgoing
          .writeHead(401)
          .end(JSON.stringify({ ok: false, error_code: 401, description: "synthetic rejection" }));
        return;
      }
      let result: unknown;
      if (method === "getMe") result = { id, is_bot: true, username: `SyntheticBot_${id}` };
      else if (method === "getWebhookInfo")
        result = {
          url: urls.get(token) ?? "",
          pending_update_count: 0,
          has_custom_certificate: false,
        };
      else {
        mutations.push({ token, method, body });
        if (method === "setWebhook") urls.set(token, String(body.url));
        else urls.delete(token);
        if (unknown.delete(token)) {
          outgoing.writeHead(503).end("synthetic uncertain outcome");
          return;
        }
        const barrier = barriers.get(token);
        if (barrier) {
          barrier.entered();
          await barrier.released;
        }
        result = true;
      }
      outgoing.setHeader("content-type", "application/json");
      outgoing.end(JSON.stringify({ ok: true, result }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing synthetic Telegram address");
    process.env.TELEGRAM_API_BASE_URL = `http://127.0.0.1:${address.port}`;
    process.env.WEB_ORIGIN = "https://pubrick.example.invalid";
    process.env.DATABASE_URL = database;
    process.env.BETTER_AUTH_SECRET ??= "synthetic-telegram-setup-session-secret";
    process.env.APP_ENCRYPTION_KEY ??= Buffer.alloc(32, 17).toString("base64");
    db = (await import("../db")).db;
    const { AppModule } = await import("../app.module");
    const { installTelegramWebhookParser } = await import("./telegram-webhook-parser");
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication<NestExpressApplication>({ bodyParser: false });
    installTelegramWebhookParser(app);
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  });
  afterAll(async () => {
    await app?.close();
    await new Promise<void>((resolve, reject) =>
      server?.close((error) => (error ? reject(error) : resolve())),
    );
  });
  async function fixture() {
    const agent = request.agent(app.getHttpServer());
    const suffix = randomUUID();
    await agent
      .post("/api/auth/sign-up/email")
      .send({
        email: `setup-${suffix}@example.invalid`,
        password: "synthetic-password123",
        name: "Synthetic Owner",
      })
      .expect(200);
    const organization = await agent
      .post("/api/auth/organization/create")
      .send({ name: "Synthetic setup", slug: `setup-${suffix}` })
      .expect(200);
    const orgId = organization.body.id as string;
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    const id = randomInt(100000, 1000000000);
    const token = `${id}:synthetic_token`;
    tokens.set(token, id);
    await replace(agent, token).expect(200);
    return { agent, orgId, token };
  }
  function replace(agent: request.Agent, token: string) {
    return agent.put("/api/notifications").send({
      enabled: true,
      draftReady: true,
      deliveryProblem: true,
      botToken: token,
      chatId: "12345",
    });
  }
  const status = (agent: request.Agent) => agent.get("/api/notifications/telegram-decisions");
  const setup = (agent: request.Agent, revision: number) =>
    agent.post("/api/notifications/telegram-decisions/setup").send({ revision });
  const disable = (agent: request.Agent, revision: number) =>
    agent.post("/api/notifications/telegram-decisions/disable").send({ revision });

  it("installs an owned bot, binds a human, then disables before token replacement", async () => {
    const f = await fixture();
    expect((await status(f.agent).expect(200)).body.state).toBe("disabled");
    const configured = await setup(f.agent, 1).expect(200);
    expect(configured.body).toMatchObject({
      state: "active",
      revision: 2,
      generation: 1,
      remoteMutationBlocked: false,
    });
    const install = mutations.filter((call) => call.token === f.token)[0];
    expect(install?.body.drop_pending_updates).toBe(false);
    expect(install?.body.allowed_updates).toEqual(["message", "callback_query"]);
    if (!install) throw new Error("Expected one physical installation");
    const route = new URL(String(install.body.url)).pathname;
    const issued = await f.agent
      .post("/api/notifications/telegram-binding/challenge")
      .send({})
      .expect(200);
    const code = new URL(issued.body.startUrl as string).searchParams.get("start");
    await request(app.getHttpServer())
      .post(route)
      .set("x-telegram-bot-api-secret-token", String(install.body.secret_token))
      .send({
        update_id: 10,
        message: {
          message_id: 10,
          text: `/start ${code}`,
          from: { id: 777, is_bot: false, first_name: "Synthetic" },
          chat: { id: 777, type: "private" },
        },
      })
      .expect(200);
    await f.agent
      .post("/api/notifications/telegram-binding/confirm")
      .send({ challengeId: issued.body.challengeId })
      .expect(200);
    expect((await f.agent.get("/api/notifications/telegram-binding").expect(200)).body.state).toBe(
      "linked",
    );
    await replace(f.agent, "90000:replacement_token").expect(409);
    const disabled = await disable(f.agent, 2).expect(200);
    expect(disabled.body.state).toBe("disabled");
    expect((await f.agent.get("/api/notifications/telegram-binding").expect(200)).body.state).toBe(
      "revoked",
    );
    expect(mutations.filter((call) => call.token === f.token).map((call) => call.method)).toEqual([
      "setWebhook",
      "deleteWebhook",
    ]);
    await request(app.getHttpServer())
      .post(route)
      .set("x-telegram-bot-api-secret-token", String(install.body.secret_token))
      .send({ update_id: 11 })
      .expect(200);
    await replace(f.agent, "90000:replacement_token").expect(200);
  });

  it("keeps an unknown predecessor after exact retry and recovers only with a different bot", async () => {
    const f = await fixture();
    unknown.add(f.token);
    expect((await setup(f.agent, 1).expect(200)).body).toMatchObject({
      state: "setup_uncertain",
      remoteMutationBlocked: true,
    });
    expect((await setup(f.agent, 2).expect(200)).body).toMatchObject({
      state: "active",
      revision: 3,
      remoteMutationBlocked: true,
    });
    const calls = mutations.filter((call) => call.token === f.token);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toEqual(calls[0]?.body);
    expect((await disable(f.agent, 3).expect(200)).body.state).toBe("disconnect_uncertain");
    expect(mutations.filter((call) => call.token === f.token)).toHaveLength(2);
    // Unresolved work cannot be recovered by reinstalling the same identity.
    await setup(f.agent, 4).expect(409);
    expect(mutations.filter((call) => call.token === f.token)).toHaveLength(2);
    const newId = randomInt(100000, 1000000000);
    const token = `${newId}:new_verified_token`;
    tokens.set(token, newId);
    await replace(f.agent, token).expect(200);
    expect((await setup(f.agent, 4).expect(200)).body).toMatchObject({
      state: "active",
      generation: 2,
      remoteMutationBlocked: false,
    });
    const [old] = await db
      .select({
        id: schema.telegramBotIdentities.id,
        quarantined: schema.telegramBotIdentities.quarantined,
        enabled: schema.telegramBotIdentities.enabled,
      })
      .from(schema.telegramBotIdentities)
      .where(eq(schema.telegramBotIdentities.botId, String(tokens.get(f.token))));
    expect(old).toMatchObject({ quarantined: true, enabled: false });
    const ledger = await db
      .select({ outcome: schema.telegramRemoteAttempts.outcome })
      .from(schema.telegramRemoteAttempts)
      .where(eq(schema.telegramRemoteAttempts.botIdentityId, old?.id ?? ""));
    expect(ledger.map((row) => row.outcome).sort()).toEqual(["confirmed", "unknown"]);
  });

  it("does not reactivate after disable while the provider response is delayed", async () => {
    const f = await fixture();
    let entered!: () => void;
    let release!: () => void;
    const seen = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    barriers.set(f.token, { entered, released });
    const pending = setup(f.agent, 1).then((response) => response);
    try {
      await Promise.race([
        seen,
        pending.then(() => {
          throw new Error("Setup completed before provider barrier");
        }),
      ]);
      expect((await status(f.agent).expect(200)).body.state).toBe("validating");
      expect((await disable(f.agent, 2).expect(200)).body.state).toBe("disconnect_uncertain");
    } finally {
      release();
      barriers.delete(f.token);
    }
    expect((await pending).status).toBe(200);
    expect((await status(f.agent).expect(200)).body.state).toBe("disconnect_uncertain");
    const [bot] = await db
      .select({
        enabled: schema.telegramBotIdentities.enabled,
        quarantined: schema.telegramBotIdentities.quarantined,
      })
      .from(schema.telegramBotIdentities)
      .where(eq(schema.telegramBotIdentities.botId, String(tokens.get(f.token))));
    expect(bot).toEqual({ enabled: false, quarantined: true });
    expect(mutations.filter((call) => call.token === f.token).map((call) => call.method)).toEqual([
      "setWebhook",
    ]);
  });

  it("keeps an orphaned bot quarantined when tenant deletion overlaps a provider attempt", async () => {
    const f = await fixture();
    let entered!: () => void;
    let release!: () => void;
    const seen = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    barriers.set(f.token, { entered, released });
    const pending = setup(f.agent, 1).then((response) => response);
    try {
      await Promise.race([
        seen,
        pending.then(() => {
          throw new Error("Setup completed before provider barrier");
        }),
      ]);
      await db.delete(schema.organization).where(eq(schema.organization.id, f.orgId));
    } finally {
      release();
      barriers.delete(f.token);
    }
    expect([403, 404]).toContain((await pending).status);
    const [bot] = await db
      .select({
        id: schema.telegramBotIdentities.id,
        ownerOrgId: schema.telegramBotIdentities.ownerOrgId,
        enabled: schema.telegramBotIdentities.enabled,
        quarantined: schema.telegramBotIdentities.quarantined,
      })
      .from(schema.telegramBotIdentities)
      .where(eq(schema.telegramBotIdentities.botId, String(tokens.get(f.token))));
    expect(bot).toMatchObject({ ownerOrgId: null, enabled: false, quarantined: true });
    const ledger = await db
      .select({ outcome: schema.telegramRemoteAttempts.outcome })
      .from(schema.telegramRemoteAttempts)
      .where(eq(schema.telegramRemoteAttempts.botIdentityId, bot?.id ?? ""));
    expect(ledger).toEqual([{ outcome: "confirmed" }]);
    expect(
      await db
        .select({ orgId: schema.telegramDecisionConfigs.orgId })
        .from(schema.telegramDecisionConfigs)
        .where(eq(schema.telegramDecisionConfigs.orgId, f.orgId)),
    ).toEqual([]);
  });

  it("refuses foreign webhooks without a physical mutation or tenant reservation", async () => {
    const f = await fixture();
    urls.set(f.token, "https://another.example.invalid/webhook");
    await setup(f.agent, 1).expect(409);
    expect(mutations.filter((call) => call.token === f.token)).toEqual([]);
    const configs = await db
      .select({ id: schema.telegramDecisionConfigs.botIdentityId })
      .from(schema.telegramDecisionConfigs)
      .where(eq(schema.telegramDecisionConfigs.orgId, f.orgId));
    expect(configs).toEqual([]);
  });

  it("durably disables despite unreadable retry ciphertext", async () => {
    const f = await fixture();
    await setup(f.agent, 1).expect(200);
    // A plain metadata write may corrupt ciphertext without changing generation;
    // inject corruption through a source-valid new generation, then activate the fixture.
    const [config] = await db
      .select({ identityId: schema.telegramDecisionConfigs.botIdentityId })
      .from(schema.telegramDecisionConfigs)
      .where(eq(schema.telegramDecisionConfigs.orgId, f.orgId));
    if (!config) throw new Error("Missing setup fixture");
    await db
      .update(schema.telegramBotIdentities)
      .set({ generation: 2 })
      .where(eq(schema.telegramBotIdentities.id, config.identityId));
    await db
      .update(schema.telegramDecisionConfigs)
      .set({ generation: 2, revision: 3, retryPayloadEncrypted: "unreadable-synthetic-ciphertext" })
      .where(eq(schema.telegramDecisionConfigs.orgId, f.orgId));
    expect((await disable(f.agent, 3).expect(200)).body.state).toBe("disconnect_uncertain");
    const [bot] = await db
      .select({ enabled: schema.telegramBotIdentities.enabled })
      .from(schema.telegramBotIdentities)
      .where(
        and(
          eq(schema.telegramBotIdentities.id, config.identityId),
          eq(schema.telegramBotIdentities.ownerOrgId, f.orgId),
        ),
      );
    expect(bot?.enabled).toBe(false);
  });
});
