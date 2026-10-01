import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import { hashEditorialSnapshot, readEditorialSnapshot, schema } from "@pubrick/db";
import { encryptJson, withHashtags } from "@pubrick/shared";
import { and, eq } from "drizzle-orm";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
describe.skipIf(!url)("Telegram draft decisions through authenticated native callbacks", () => {
  let app: NestExpressApplication;
  let server: Server;
  let baseUrl: string;
  let db: typeof import("../db")["db"];
  const bots = new Map<string, number>();
  const unknown = new Set<string>();
  const rejected = new Set<string>();
  const sent: Array<{ token: string; body: Record<string, unknown> }> = [];
  const answers: Array<{ token: string; body: Record<string, unknown> }> = [];
  beforeAll(async () => {
    server = createServer(async (incoming, outgoing) => {
      const match = /^\/bot([^/]+)\/(sendMessage|answerCallbackQuery)$/.exec(incoming.url ?? "");
      if (!match?.[1] || !match[2]) {
        outgoing.writeHead(404).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
      const botId = bots.get(match[1]);
      if (!botId) {
        outgoing.writeHead(401).end(JSON.stringify({ ok: false, error_code: 401 }));
        return;
      }
      if (match[2] === "sendMessage") {
        sent.push({ token: match[1], body });
        if (rejected.delete(match[1])) {
          outgoing.writeHead(400).end(JSON.stringify({ ok: false, error_code: 400 }));
          return;
        }
        if (unknown.delete(match[1])) {
          outgoing.writeHead(503).end("synthetic uncertain send");
          return;
        }
      } else answers.push({ token: match[1], body });
      outgoing.setHeader("content-type", "application/json");
      outgoing.end(
        JSON.stringify({
          ok: true,
          result:
            match[2] === "answerCallbackQuery"
              ? true
              : {
                  message_id: 500 + sent.filter((row) => row.token === match[1]).length,
                  from: { id: botId, is_bot: true },
                  chat: { id: Number(body.chat_id), type: "private" },
                },
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing synthetic provider");
    baseUrl = `http://127.0.0.1:${address.port}`;
    process.env.TELEGRAM_API_BASE_URL = baseUrl;
    process.env.DATABASE_URL = url;
    process.env.WEB_ORIGIN = "https://pubrick.example.invalid";
    process.env.BETTER_AUTH_SECRET ??= "synthetic-telegram-decisions-session-secret";
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
  async function fixture(expired = false) {
    const agent = request.agent(app.getHttpServer());
    const suffix = randomUUID();
    const signup = await agent
      .post("/api/auth/sign-up/email")
      .send({
        email: `decision-${suffix}@example.invalid`,
        password: "synthetic-password123",
        name: "Synthetic Editor",
      })
      .expect(200);
    const userId = signup.body.user.id as string;
    const organization = await agent
      .post("/api/auth/organization/create")
      .send({ name: "Synthetic decisions", slug: `decision-${suffix}` })
      .expect(200);
    const orgId = organization.body.id as string;
    const botId = randomInt(100000, 1000000000);
    const token = `${botId}:synthetic_decision_token`;
    const encryptionKey = process.env.APP_ENCRYPTION_KEY;
    if (!encryptionKey) throw new Error("Missing synthetic encryption key");
    bots.set(token, botId);
    const routeId = randomBytes(32).toString("base64url"),
      secret = randomBytes(32).toString("base64url");
    const [bot] = await db
      .insert(schema.telegramBotIdentities)
      .values({ botId: String(botId), ownerOrgId: orgId, enabled: true })
      .returning();
    if (!bot) throw new Error("Missing owned bot");
    await db.insert(schema.telegramDecisionConfigs).values({
      orgId,
      botIdentityId: bot.id,
      generation: 1,
      state: "active",
      routeId,
      secretHash: hash(secret),
      credentialsEncrypted: encryptJson({ botToken: token }, encryptionKey),
      retryPayloadEncrypted: encryptJson(
        {
          botId: String(botId),
          botUsername: `SyntheticBot_${botId}`,
          request: {
            url: `https://pubrick.example.invalid/api/telegram/webhook/${routeId}`,
            secret_token: secret,
            allowed_updates: ["message", "callback_query"],
            drop_pending_updates: false,
            max_connections: 40,
          },
        },
        encryptionKey,
      ),
    });
    const [binding] = await db
      .insert(schema.telegramBindings)
      .values({
        orgId,
        userId,
        botIdentityId: bot.id,
        generation: 1,
        telegramUserId: "777",
        privateChatId: "777",
      })
      .returning();
    const [brand] = await db
      .insert(schema.brands)
      .values({ orgId, name: "Synthetic Brand" })
      .returning();
    if (!brand || !binding) throw new Error("Missing actor/brand");
    const [item] = await db
      .insert(schema.contentItems)
      .values({
        orgId,
        brandId: brand.id,
        title: "Synthetic Draft",
        body: "Synthetic unchanged master body.",
      })
      .returning();
    const [channel] = await db
      .insert(schema.channels)
      .values({
        orgId,
        brandId: brand.id,
        name: "Synthetic Channel",
        platform: "telegram",
        credentialsEncrypted: "synthetic-unused",
      })
      .returning();
    if (!item || !channel) throw new Error("Missing content/channel");
    const [adaptation] = await db
      .insert(schema.adaptations)
      .values({ orgId, contentItemId: item.id, channelId: channel.id })
      .returning();
    if (!adaptation) throw new Error("Missing pending adaptation");
    const snapshot = await readEditorialSnapshot(db, orgId, item.id);
    if (!snapshot) throw new Error("Missing snapshot");
    const code = randomBytes(32).toString("base64url");
    const now = new Date(),
      createdAt = expired ? new Date(now.getTime() - 120000) : now,
      expiresAt = new Date(now.getTime() + (expired ? -60000 : 1200000));
    const [initial] = await db
      .insert(schema.telegramInitialCapabilities)
      .values({
        orgId,
        botIdentityId: bot.id,
        generation: 1,
        contentItemId: item.id,
        brandId: brand.id,
        snapshotHash: hashEditorialSnapshot(snapshot),
        snapshotVersion: "client-review-v1",
        tokenHash: hash(code),
        chatId: "-10042",
        messageId: "100",
        sendState: "sent",
        sendAttemptedAt: createdAt,
        createdAt,
        expiresAt,
      })
      .returning();
    if (!initial) throw new Error("Missing initial capability");
    return {
      orgId,
      userId,
      botId,
      identityId: bot.id,
      token,
      routeId,
      secret,
      bindingId: binding.id,
      itemId: item.id,
      adaptationId: adaptation.id,
      channelId: channel.id,
      brandId: brand.id,
      initialId: initial.id,
      code,
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function callback(f: Fixture, data: string, updateId: number, sender = 777, messageId = 501) {
    const first = data.startsWith("ir:");
    return {
      update_id: updateId,
      callback_query: {
        id: `synthetic-${updateId}`,
        from: { id: sender, is_bot: false },
        data,
        message: {
          message_id: first ? 100 : messageId,
          date: 1,
          from: { id: f.botId, is_bot: true },
          chat: { id: first ? -10042 : sender, type: first ? "supergroup" : "private" },
        },
      },
    };
  }
  const post = (f: Fixture, payload: ReturnType<typeof callback>) =>
    request(app.getHttpServer())
      .post(`/api/telegram/webhook/${f.routeId}`)
      .set("x-telegram-bot-api-secret-token", f.secret)
      .send(payload);
  async function begin(f: Fixture, updateId = 1) {
    await post(f, callback(f, `ir:${f.code}`, updateId)).expect(200);
    const physical = sent.filter((row) => row.token === f.token);
    expect(physical).toHaveLength(1);
    const keyboard = physical[0]?.body.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data?: string }>>;
    };
    const reject = keyboard.inline_keyboard[1]?.[0]?.callback_data;
    if (!reject) throw new Error("Missing private Reject callback");
    return reject;
  }
  async function status(f: Fixture) {
    const [item] = await db
      .select({ status: schema.contentItems.status })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, f.orgId), eq(schema.contentItems.id, f.itemId)));
    const audit = await db
      .select({
        actorUserId: schema.telegramDecisionAudit.actorUserId,
        bindingId: schema.telegramDecisionAudit.bindingId,
        action: schema.telegramDecisionAudit.action,
        updateId: schema.telegramDecisionAudit.updateId,
      })
      .from(schema.telegramDecisionAudit)
      .where(eq(schema.telegramDecisionAudit.orgId, f.orgId));
    return { status: item?.status, audit };
  }
  async function livePublishJobs(f: Fixture) {
    const { QueueService } = await import("../queue/queue.service");
    return db.transaction((tx) =>
      app.get(QueueService).hasLivePublishJobs(tx, f.orgId, [f.adaptationId]),
    );
  }
  async function nativeClient(): Promise<pg.Client> {
    if (!url || !/^pubrick_[a-zA-Z0-9_]+_test$/.test(new URL(url).pathname.slice(1)))
      throw new Error("Callback proof requires an explicitly disposable pubrick_*_test database");
    const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
    await client.connect();
    return client;
  }
  async function secondEditor(f: Fixture) {
    const agent = request.agent(app.getHttpServer());
    const suffix = randomUUID();
    const signup = await agent
      .post("/api/auth/sign-up/email")
      .send({
        email: `second-decision-${suffix}@example.invalid`,
        password: "synthetic-password123",
        name: "Second Synthetic Editor",
      })
      .expect(200);
    const userId = signup.body.user.id as string;
    const memberId = randomUUID();
    await db
      .insert(schema.member)
      .values({ id: memberId, organizationId: f.orgId, userId, role: "editor" });
    await db.insert(schema.brandAccess).values({ orgId: f.orgId, brandId: f.brandId, memberId });
    const [binding] = await db
      .insert(schema.telegramBindings)
      .values({
        orgId: f.orgId,
        userId,
        botIdentityId: f.identityId,
        generation: 1,
        telegramUserId: "888",
        privateChatId: "888",
      })
      .returning({ id: schema.telegramBindings.id });
    if (!binding) throw new Error("Missing second editor binding");
    return { userId, memberId, bindingId: binding.id };
  }
  it("refuses unbound actors without consuming the shared initial, then rejects exactly once", async () => {
    const f = await fixture();
    await post(f, callback(f, `ir:${f.code}`, 1, 888)).expect(200);
    expect(sent.filter((row) => row.token === f.token)).toHaveLength(0);
    const reject = await begin(f, 2);
    await post(f, callback(f, `ir:${f.code}`, 2)).expect(200);
    expect(sent.filter((row) => row.token === f.token)).toHaveLength(1);
    expect((await status(f)).status).toBe("draft");
    await post(f, callback(f, reject, 3)).expect(200);
    await post(f, callback(f, reject, 3)).expect(200);
    const done = await status(f);
    expect(done.status).toBe("rejected");
    expect(done.audit).toHaveLength(1);
    expect(await livePublishJobs(f)).toBe(false);
    expect(done.audit[0]).toMatchObject({
      actorUserId: f.userId,
      bindingId: f.bindingId,
      action: "reject",
      updateId: "3",
    });
    const [initial] = await db
      .select({ state: schema.telegramInitialCapabilities.state })
      .from(schema.telegramInitialCapabilities)
      .where(eq(schema.telegramInitialCapabilities.id, f.initialId));
    expect(initial?.state).toBe("revoked");
    const confirmations = await db
      .select({ state: schema.telegramActorConfirmations.state })
      .from(schema.telegramActorConfirmations)
      .where(eq(schema.telegramActorConfirmations.orgId, f.orgId));
    expect(confirmations).toEqual([{ state: "consumed" }]);
    const receipts = await db
      .select({ id: schema.telegramUpdateReceipts.id })
      .from(schema.telegramUpdateReceipts)
      .where(eq(schema.telegramUpdateReceipts.orgId, f.orgId));
    expect(receipts).toHaveLength(3);
  });
  it("refuses a stale full snapshot and changed replay payload", async () => {
    const f = await fixture();
    const reject = await begin(f);
    await db
      .update(schema.contentItems)
      .set({ body: "Changed master body." })
      .where(eq(schema.contentItems.id, f.itemId));
    await post(f, callback(f, reject, 2)).expect(200);
    expect(await status(f)).toEqual({ status: "draft", audit: [] });
    await post(f, callback(f, reject, 2, 888)).expect(409);
  });
  it("revokes an incompatible old confirmation after an explicit fresh notification click", async () => {
    const f = await fixture();
    const oldReject = await begin(f);
    await db
      .update(schema.contentItems)
      .set({ body: "Explicitly revised draft body." })
      .where(eq(schema.contentItems.id, f.itemId));
    const snapshot = await readEditorialSnapshot(db, f.orgId, f.itemId);
    if (!snapshot) throw new Error("Missing revised snapshot");
    const code = randomBytes(32).toString("base64url");
    const now = new Date();
    await db.insert(schema.telegramInitialCapabilities).values({
      orgId: f.orgId,
      botIdentityId: f.identityId,
      generation: 1,
      contentItemId: f.itemId,
      brandId: snapshot.brandId,
      snapshotHash: hashEditorialSnapshot(snapshot),
      snapshotVersion: "client-review-v1",
      tokenHash: hash(code),
      chatId: "-10042",
      messageId: "100",
      sendState: "sent",
      sendAttemptedAt: now,
      createdAt: now,
      expiresAt: new Date(now.getTime() + 1200000),
    });
    await post(f, callback(f, `ir:${code}`, 2)).expect(200);
    const physical = sent.filter((row) => row.token === f.token);
    expect(physical).toHaveLength(2);
    const keyboard = physical[1]?.body.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data?: string }>>;
    };
    const newReject = keyboard.inline_keyboard[1]?.[0]?.callback_data;
    if (!newReject) throw new Error("Missing fresh private confirmation");
    const caps = await db
      .select({ state: schema.telegramActorConfirmations.state })
      .from(schema.telegramActorConfirmations)
      .where(eq(schema.telegramActorConfirmations.orgId, f.orgId));
    expect(caps.map((row) => row.state).sort()).toEqual(["pending", "revoked"]);
    await post(f, callback(f, oldReject, 3)).expect(200);
    expect((await status(f)).status).toBe("draft");
    await post(f, callback(f, newReject, 4, 777, 502)).expect(200);
    expect((await status(f)).audit).toHaveLength(1);
  });

  it("admits one private send and one rejection under competing callback updates", async () => {
    const f = await fixture();
    await Promise.all([
      post(f, callback(f, `ir:${f.code}`, 1)).expect(200),
      post(f, callback(f, `ir:${f.code}`, 2)).expect(200),
    ]);
    const physical = sent.filter((row) => row.token === f.token);
    expect(physical).toHaveLength(1);
    const keyboard = physical[0]?.body.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data?: string }>>;
    };
    const reject = keyboard.inline_keyboard[1]?.[0]?.callback_data;
    if (!reject) throw new Error("Missing single private confirmation");
    await Promise.all([
      post(f, callback(f, reject, 3)).expect(200),
      post(f, callback(f, reject, 4)).expect(200),
    ]);
    const done = await status(f);
    expect(done.status).toBe("rejected");
    expect(done.audit).toHaveLength(1);
    const finals = await db
      .select({ id: schema.telegramActorConfirmations.id })
      .from(schema.telegramActorConfirmations)
      .where(eq(schema.telegramActorConfirmations.orgId, f.orgId));
    expect(finals).toHaveLength(1);
  });
  it.each(["membership", "binding"] as const)(
    "refuses fresh final decisions after %s revocation",
    async (kind) => {
      const f = await fixture();
      const reject = await begin(f);
      if (kind === "membership")
        await db
          .update(schema.member)
          .set({ role: "author" })
          .where(
            and(eq(schema.member.organizationId, f.orgId), eq(schema.member.userId, f.userId)),
          );
      else
        await db
          .update(schema.telegramBindings)
          .set({ state: "revoked", revokedAt: new Date() })
          .where(eq(schema.telegramBindings.id, f.bindingId));
      await post(f, callback(f, reject, 2)).expect(200);
      expect(await status(f)).toEqual({ status: "draft", audit: [] });
      await post(f, callback(f, `ir:${f.code}`, 1)).expect(200);
      const ack = answers.filter((row) => row.token === f.token).at(-1);
      expect(ack?.body.text).toBe(
        "This action is unavailable. Check your account connection and review the draft in Pubrick.",
      );
    },
  );
  it("reconciles an unknown private send only for its intended bound actor", async () => {
    const f = await fixture();
    unknown.add(f.token);
    const reject = await begin(f);
    await post(f, callback(f, reject, 2, 888)).expect(200);
    expect((await status(f)).status).toBe("draft");
    await post(f, callback(f, reject, 3)).expect(200);
    expect((await status(f)).audit).toHaveLength(1);
    const [cap] = await db
      .select({
        messageId: schema.telegramActorConfirmations.messageId,
        sendState: schema.telegramActorConfirmations.sendState,
        state: schema.telegramActorConfirmations.state,
      })
      .from(schema.telegramActorConfirmations)
      .where(eq(schema.telegramActorConfirmations.orgId, f.orgId));
    expect(cap).toMatchObject({ messageId: "501", sendState: "sent", state: "consumed" });
    expect(sent.filter((row) => row.token === f.token)).toHaveLength(1);
  });
  it("terminalizes a definitely rejected private send and permits a fresh explicit click", async () => {
    const f = await fixture();
    rejected.add(f.token);
    await begin(f);
    const [failed] = await db
      .select({
        state: schema.telegramActorConfirmations.state,
        terminalAt: schema.telegramActorConfirmations.terminalAt,
        sendState: schema.telegramActorConfirmations.sendState,
      })
      .from(schema.telegramActorConfirmations)
      .where(eq(schema.telegramActorConfirmations.orgId, f.orgId));
    expect(failed).toMatchObject({ state: "revoked", sendState: "rejected" });
    expect(failed?.terminalAt).not.toBeNull();
    await post(f, callback(f, `ir:${f.code}`, 2)).expect(200);
    const physical = sent.filter((row) => row.token === f.token);
    expect(physical).toHaveLength(2);
    const keyboard = physical[1]?.body.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data?: string }>>;
    };
    const reject = keyboard.inline_keyboard[1]?.[0]?.callback_data;
    if (!reject) throw new Error("Missing retry confirmation");
    await post(f, callback(f, reject, 3, 777, 502)).expect(200);
    expect((await status(f)).audit).toHaveLength(1);
  });
  it("cancel consumes only the actor confirmation; expired initial capabilities issue nothing", async () => {
    const f = await fixture();
    const reject = await begin(f);
    await post(f, callback(f, reject.replace(/^cr:/, "ca:"), 2)).expect(200);
    await post(f, callback(f, reject, 3)).expect(200);
    expect(await status(f)).toEqual({ status: "draft", audit: [] });
    const [initial] = await db
      .select({ state: schema.telegramInitialCapabilities.state })
      .from(schema.telegramInitialCapabilities)
      .where(eq(schema.telegramInitialCapabilities.id, f.initialId));
    expect(initial?.state).toBe("pending");
    const expired = await fixture(true);
    await post(expired, callback(expired, `ir:${expired.code}`, 1)).expect(200);
    expect(sent.filter((row) => row.token === expired.token)).toHaveLength(0);
  });
  it("refuses delivery history added after confirmation issuance", async () => {
    const f = await fixture();
    const reject = await begin(f);
    await db
      .update(schema.contentItems)
      .set({ isSafeToDelete: false })
      .where(eq(schema.contentItems.id, f.itemId));
    await post(f, callback(f, reject, 2)).expect(200);
    expect(await status(f)).toEqual({ status: "draft", audit: [] });
  });
  it("refuses an expired private capability without changing content", async () => {
    const f = await fixture(true);
    const [parent] = await db
      .select({
        id: schema.telegramInitialCapabilities.id,
        brandId: schema.telegramInitialCapabilities.brandId,
        snapshotHash: schema.telegramInitialCapabilities.snapshotHash,
        snapshotVersion: schema.telegramInitialCapabilities.snapshotVersion,
        createdAt: schema.telegramInitialCapabilities.createdAt,
        expiresAt: schema.telegramInitialCapabilities.expiresAt,
      })
      .from(schema.telegramInitialCapabilities)
      .where(eq(schema.telegramInitialCapabilities.id, f.initialId));
    if (!parent) throw new Error("Missing expired parent");
    const code = randomBytes(32).toString("base64url");
    await db.insert(schema.telegramActorConfirmations).values({
      orgId: f.orgId,
      botIdentityId: f.identityId,
      generation: 1,
      contentItemId: f.itemId,
      brandId: parent.brandId,
      snapshotHash: parent.snapshotHash,
      snapshotVersion: parent.snapshotVersion,
      tokenHash: hash(code),
      chatId: "777",
      messageId: "501",
      userId: f.userId,
      bindingId: f.bindingId,
      initialCapabilityId: parent.id,
      initialExpiresAt: parent.expiresAt,
      createdAt: parent.createdAt,
      expiresAt: parent.expiresAt,
      sendState: "sent",
      sendAttemptedAt: parent.createdAt,
    });
    await post(f, callback(f, `cr:${code}`, 1)).expect(200);
    expect(await status(f)).toEqual({ status: "draft", audit: [] });
    expect(await livePublishJobs(f)).toBe(false);
  });
  it("rolls back rejection, consumption and replay when audit storage fails, then retries once", async () => {
    const f = await fixture();
    const reject = await begin(f);
    const client = await nativeClient();
    const name = pg.escapeIdentifier(`telegram_proof_audit_${randomUUID().replaceAll("-", "")}`);
    let functionCreated = false;
    let triggerCreated = false;
    try {
      // Unique trigger name and tenant predicate make concurrent fixture copies inert for each other.
      await client.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $proof$
        BEGIN IF NEW.org_id = ${pg.escapeLiteral(f.orgId)} THEN
          RAISE EXCEPTION 'Synthetic tenant audit storage failure';
        END IF; RETURN NEW; END $proof$`);
      functionCreated = true;
      await client.query(
        `CREATE TRIGGER ${name} BEFORE INSERT ON telegram_decision_audit FOR EACH ROW EXECUTE FUNCTION ${name}()`,
      );
      triggerCreated = true;
      await post(f, callback(f, reject, 2)).expect(500);
      expect(await status(f)).toEqual({ status: "draft", audit: [] });
      const [cap] = await db
        .select({
          state: schema.telegramActorConfirmations.state,
          terminalAt: schema.telegramActorConfirmations.terminalAt,
        })
        .from(schema.telegramActorConfirmations)
        .where(eq(schema.telegramActorConfirmations.orgId, f.orgId));
      expect(cap).toEqual({ state: "pending", terminalAt: null });
      const finalReceipts = await db
        .select({ id: schema.telegramUpdateReceipts.id })
        .from(schema.telegramUpdateReceipts)
        .where(
          and(
            eq(schema.telegramUpdateReceipts.orgId, f.orgId),
            eq(schema.telegramUpdateReceipts.updateId, "2"),
          ),
        );
      expect(finalReceipts).toEqual([]);
      expect(await livePublishJobs(f)).toBe(false);
      await client.query(`DROP TRIGGER ${name} ON telegram_decision_audit`);
      triggerCreated = false;
      await post(f, callback(f, reject, 2)).expect(200);
      await post(f, callback(f, reject, 2)).expect(200);
      const done = await status(f);
      expect(done.status).toBe("rejected");
      expect(done.audit).toHaveLength(1);
      expect(sent.filter((row) => row.token === f.token)).toHaveLength(1);
      expect(await livePublishJobs(f)).toBe(false);
    } finally {
      try {
        if (triggerCreated)
          await client.query(`DROP TRIGGER IF EXISTS ${name} ON telegram_decision_audit`);
      } finally {
        try {
          if (functionCreated) await client.query(`DROP FUNCTION IF EXISTS ${name}()`);
        } finally {
          await client.end();
        }
      }
    }
  });
  it("binds two editors separately and commits one competing rejection without cross-actor cancellation", async () => {
    const f = await fixture();
    const other = await secondEditor(f);
    const ownerReject = await begin(f);
    await post(f, callback(f, `ir:${f.code}`, 2, 888)).expect(200);
    const physical = sent.filter((row) => row.token === f.token);
    expect(physical).toHaveLength(2);
    expect(physical.map((row) => row.body.chat_id)).toEqual(["777", "888"]);
    const keyboard = physical[1]?.body.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data?: string }>>;
    };
    const editorReject = keyboard.inline_keyboard[1]?.[0]?.callback_data;
    if (!editorReject) throw new Error("Missing second editor confirmation");
    // The second editor cannot cancel the first editor's private capability even knowing its token.
    await post(f, callback(f, ownerReject.replace(/^cr:/, "ca:"), 3, 888)).expect(200);
    const before = await db
      .select({
        state: schema.telegramActorConfirmations.state,
        userId: schema.telegramActorConfirmations.userId,
        bindingId: schema.telegramActorConfirmations.bindingId,
        chatId: schema.telegramActorConfirmations.chatId,
      })
      .from(schema.telegramActorConfirmations)
      .where(eq(schema.telegramActorConfirmations.orgId, f.orgId));
    expect(before).toEqual(
      expect.arrayContaining([
        { state: "pending", userId: f.userId, bindingId: f.bindingId, chatId: "777" },
        { state: "pending", userId: other.userId, bindingId: other.bindingId, chatId: "888" },
      ]),
    );
    await Promise.all([
      post(f, callback(f, ownerReject, 4)).expect(200),
      post(f, callback(f, editorReject, 5, 888, 502)).expect(200),
    ]);
    const done = await status(f);
    expect(done.status).toBe("rejected");
    expect(done.audit).toHaveLength(1);
    expect([f.userId, other.userId]).toContain(done.audit[0]?.actorUserId);
    const finals = await db
      .select({ state: schema.telegramActorConfirmations.state })
      .from(schema.telegramActorConfirmations)
      .where(eq(schema.telegramActorConfirmations.orgId, f.orgId));
    expect(finals.map((row) => row.state).sort()).toEqual(["consumed", "revoked"]);
    const finalReceipts = await db
      .select({ outcome: schema.telegramUpdateReceipts.outcome })
      .from(schema.telegramUpdateReceipts)
      .where(
        and(
          eq(schema.telegramUpdateReceipts.orgId, f.orgId),
          eq(schema.telegramUpdateReceipts.operation, "confirm_reject"),
        ),
      );
    expect(finalReceipts.map((row) => row.outcome).sort()).toEqual(["accepted", "refused"]);
    expect(await livePublishJobs(f)).toBe(false);
  });
  it("waits on the actual channel writer and refuses its changed full snapshot after commit", async () => {
    const f = await fixture();
    const reject = await begin(f);
    const writer = await nativeClient();
    let observer: pg.Client | undefined;
    let committed = false;
    let pending: Promise<request.Response> | undefined;
    try {
      observer = await nativeClient();
      const activeObserver = observer;
      const identity = await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const writerPid = identity.rows[0]?.pid;
      if (!writerPid) throw new Error("Missing channel writer PID");
      await writer.query("BEGIN");
      const changed = await writer.query(
        "UPDATE channels SET name = $1 WHERE org_id = $2 AND id = $3",
        ["Changed by actual writer", f.orgId, f.channelId],
      );
      expect(changed.rowCount).toBe(1);
      let settled = false;
      pending = post(f, callback(f, reject, 2)).then((response) => {
        settled = true;
        return response;
      });
      await expect
        .poll(
          async () => {
            if (settled)
              throw new Error("Callback completed without waiting for the channel writer");
            const blocked = await activeObserver.query<{ waiting: boolean }>(
              `SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND $1::int = ANY(pg_blocking_pids(pid))
          AND query LIKE '%channels%'
        ) AS waiting`,
              [writerPid],
            );
            return blocked.rows[0]?.waiting;
          },
          { timeout: 5000, interval: 25 },
        )
        .toBe(true);
      await writer.query("COMMIT");
      committed = true;
      expect((await pending).status).toBe(200);
      expect(await status(f)).toEqual({ status: "draft", audit: [] });
      const [cap] = await db
        .select({ state: schema.telegramActorConfirmations.state })
        .from(schema.telegramActorConfirmations)
        .where(eq(schema.telegramActorConfirmations.orgId, f.orgId));
      expect(cap?.state).toBe("pending");
      const [refused] = await db
        .select({ outcome: schema.telegramUpdateReceipts.outcome })
        .from(schema.telegramUpdateReceipts)
        .where(
          and(
            eq(schema.telegramUpdateReceipts.orgId, f.orgId),
            eq(schema.telegramUpdateReceipts.updateId, "2"),
          ),
        );
      expect(refused?.outcome).toBe("refused");
      expect(await livePublishJobs(f)).toBe(false);
    } finally {
      try {
        if (!committed) await writer.query("ROLLBACK");
      } finally {
        try {
          await pending;
        } finally {
          try {
            await observer?.end();
          } finally {
            await writer.end();
          }
        }
      }
    }
  });
  async function writerFirstFinal(
    f: Fixture,
    payload: ReturnType<typeof callback>,
    table: string,
    mutate: (writer: pg.Client) => Promise<void>,
  ) {
    const writer = await nativeClient();
    let observer: pg.Client | undefined;
    let committed = false;
    let pending: Promise<request.Response> | undefined;
    try {
      observer = await nativeClient();
      const activeObserver = observer;
      const { rows } = await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const writerPid = rows[0]?.pid;
      if (!writerPid) throw new Error("Missing authority writer PID");
      await writer.query("BEGIN");
      await mutate(writer);
      let settled = false;
      pending = post(f, payload).then((response) => {
        settled = true;
        return response;
      });
      await expect
        .poll(
          async () => {
            if (settled)
              throw new Error("Final callback completed without waiting on its authority writer");
            const blocked = await activeObserver.query<{ waiting: boolean }>(
              `SELECT EXISTS (SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND $1::int = ANY(pg_blocking_pids(pid)) AND query LIKE $2) AS waiting`,
              [writerPid, `%${table}%`],
            );
            return blocked.rows[0]?.waiting;
          },
          { timeout: 5000, interval: 25 },
        )
        .toBe(true);
      await writer.query("COMMIT");
      committed = true;
      return await pending;
    } finally {
      try {
        if (!committed) await writer.query("ROLLBACK");
      } finally {
        try {
          await pending;
        } finally {
          try {
            await observer?.end();
          } finally {
            await writer.end();
          }
        }
      }
    }
  }
  it("waits on brand grant replacement and refuses the editor after the grant is removed", async () => {
    const f = await fixture();
    const editor = await secondEditor(f);
    await post(f, callback(f, `ir:${f.code}`, 1, 888)).expect(200);
    const physical = sent.filter((row) => row.token === f.token);
    expect(physical).toHaveLength(1);
    const keyboard = physical[0]?.body.reply_markup as {
      inline_keyboard: Array<Array<{ callback_data?: string }>>;
    };
    const reject = keyboard.inline_keyboard[1]?.[0]?.callback_data;
    if (!reject) throw new Error("Missing editor confirmation");
    const response = await writerFirstFinal(
      f,
      callback(f, reject, 2, 888),
      "brands",
      async (writer) => {
        // Grant replacement takes its brand parent before touching grant rows.
        const parent = await writer.query(
          "SELECT id FROM brands WHERE org_id=$1 AND id=$2 FOR UPDATE",
          [f.orgId, f.brandId],
        );
        expect(parent.rowCount).toBe(1);
        const removed = await writer.query(
          "DELETE FROM brand_access WHERE org_id=$1 AND brand_id=$2 AND member_id=$3",
          [f.orgId, f.brandId, editor.memberId],
        );
        expect(removed.rowCount).toBe(1);
      },
    );
    expect(response.status).toBe(200);
    expect(await status(f)).toEqual({ status: "draft", audit: [] });
    const [cap] = await db
      .select({ state: schema.telegramActorConfirmations.state })
      .from(schema.telegramActorConfirmations)
      .where(eq(schema.telegramActorConfirmations.bindingId, editor.bindingId));
    expect(cap?.state).toBe("pending");
    const ack = answers.filter((row) => row.token === f.token).at(-1);
    expect(ack?.body.text).toBe(
      "This action is unavailable. Check your account connection and review the draft in Pubrick.",
    );
    expect(await livePublishJobs(f)).toBe(false);
  });
  it("waits on raw user deletion and refuses without reviving cascaded actor identity", async () => {
    const f = await fixture();
    const reject = await begin(f);
    const response = await writerFirstFinal(f, callback(f, reject, 2), '"user"', async (writer) => {
      const removed = await writer.query('DELETE FROM "user" WHERE id=$1', [f.userId]);
      expect(removed.rowCount).toBe(1);
    });
    expect(response.status).toBe(200);
    expect(await status(f)).toEqual({ status: "draft", audit: [] });
    const bindings = await db
      .select({ id: schema.telegramBindings.id })
      .from(schema.telegramBindings)
      .where(eq(schema.telegramBindings.orgId, f.orgId));
    const confirmations = await db
      .select({ id: schema.telegramActorConfirmations.id })
      .from(schema.telegramActorConfirmations)
      .where(eq(schema.telegramActorConfirmations.orgId, f.orgId));
    expect(bindings).toEqual([]);
    expect(confirmations).toEqual([]);
    const [initial] = await db
      .select({ state: schema.telegramInitialCapabilities.state })
      .from(schema.telegramInitialCapabilities)
      .where(eq(schema.telegramInitialCapabilities.id, f.initialId));
    expect(initial?.state).toBe("pending");
    const [receipt] = await db
      .select({ outcome: schema.telegramUpdateReceipts.outcome })
      .from(schema.telegramUpdateReceipts)
      .where(
        and(
          eq(schema.telegramUpdateReceipts.orgId, f.orgId),
          eq(schema.telegramUpdateReceipts.updateId, "2"),
        ),
      );
    expect(receipt?.outcome).toBe("refused");
    expect(await livePublishJobs(f)).toBe(false);
  });
  it("refuses private-only expiry while the unchanged initial capability is still valid", async () => {
    const f = await fixture();
    await begin(f);
    const expiredCode = randomBytes(32).toString("base64url");
    const reject = `cr:${expiredCode}`;
    const now = Date.now();
    await db.transaction(async (tx) => {
      // Preserve the issued capability and its immutable replay evidence. A
      // separate expired synthetic row isolates private expiry with a live parent.
      const c = schema.telegramActorConfirmations;
      const [original] = await tx
        .select({
          id: c.id,
          orgId: c.orgId,
          botIdentityId: c.botIdentityId,
          generation: c.generation,
          contentItemId: c.contentItemId,
          brandId: c.brandId,
          snapshotHash: c.snapshotHash,
          snapshotVersion: c.snapshotVersion,
          tokenHash: c.tokenHash,
          chatId: c.chatId,
          messageId: c.messageId,
          state: c.state,
          sendState: c.sendState,
          sendAttemptedAt: c.sendAttemptedAt,
          terminalAt: c.terminalAt,
          userId: c.userId,
          bindingId: c.bindingId,
          initialCapabilityId: c.initialCapabilityId,
          initialExpiresAt: c.initialExpiresAt,
        })
        .from(c)
        .where(eq(c.orgId, f.orgId))
        .for("update");
      if (!original) throw new Error("Missing pending private capability");
      expect(original.state).toBe("pending");
      expect(original.terminalAt).toBeNull();
      const auditReferences = await tx
        .select({ id: schema.telegramDecisionAudit.id })
        .from(schema.telegramDecisionAudit)
        .where(eq(schema.telegramDecisionAudit.capabilityId, original.id));
      expect(auditReferences).toEqual([]);
      await tx
        .update(c)
        .set({ state: "revoked", terminalAt: new Date(now) })
        .where(and(eq(c.orgId, f.orgId), eq(c.id, original.id)));
      await tx.insert(c).values({
        ...original,
        id: randomUUID(),
        tokenHash: hash(expiredCode),
        createdAt: new Date(now - 120000),
        sendAttemptedAt: new Date(now - 90000),
        expiresAt: new Date(now - 60000),
      });
    });
    const [parent] = await db
      .select({
        expiresAt: schema.telegramInitialCapabilities.expiresAt,
        state: schema.telegramInitialCapabilities.state,
      })
      .from(schema.telegramInitialCapabilities)
      .where(eq(schema.telegramInitialCapabilities.id, f.initialId));
    expect(parent?.state).toBe("pending");
    expect(parent?.expiresAt.getTime()).toBeGreaterThan(Date.now());
    await post(f, callback(f, reject, 2)).expect(200);
    expect(await status(f)).toEqual({ status: "draft", audit: [] });
    const [cap] = await db
      .select({
        state: schema.telegramActorConfirmations.state,
        terminalAt: schema.telegramActorConfirmations.terminalAt,
      })
      .from(schema.telegramActorConfirmations)
      .where(
        and(
          eq(schema.telegramActorConfirmations.orgId, f.orgId),
          eq(schema.telegramActorConfirmations.tokenHash, hash(expiredCode)),
        ),
      );
    expect(cap).toEqual({ state: "pending", terminalAt: null });
    const [receipt] = await db
      .select({ outcome: schema.telegramUpdateReceipts.outcome })
      .from(schema.telegramUpdateReceipts)
      .where(
        and(
          eq(schema.telegramUpdateReceipts.orgId, f.orgId),
          eq(schema.telegramUpdateReceipts.updateId, "2"),
        ),
      );
    expect(receipt?.outcome).toBe("refused");
    expect(await livePublishJobs(f)).toBe(false);
  });
  const remainingWriterRaces = [
    "member removal",
    "role downgrade",
    "bot disable",
    "binding revocation",
    "master body",
    "master title",
    "adaptation body",
    "adaptation hashtags",
    "master video media",
    "publication claim storage",
    "raw item deletion",
    "organization deletion",
  ] as const;
  it.each(remainingWriterRaces)(
    "observes writer-first %s and refuses the final decision after commit",
    async (kind) => {
      const f = await fixture();
      const reject = await begin(f);
      const before = await readEditorialSnapshot(db, f.orgId, f.itemId);
      if (!before) throw new Error("Missing race snapshot");
      // These are native writer boundaries following the production lock chain,
      // not invocations of the HTTP editor, delivery SDK or full publish queue.
      // API content writes hold the organization first, so that is the actual
      // callback wait; the worker publication claim instead starts at adaptation.
      const memberRace = kind === "member removal" || kind === "role downgrade";
      const tenantRace =
        kind === "bot disable" || kind === "binding revocation" || kind === "organization deletion";
      const claimRace = kind === "publication claim storage";
      const waitTable = memberRace ? '"member"' : claimRace ? "adaptations" : "organization";
      const response = await writerFirstFinal(
        f,
        callback(f, reject, 2),
        waitTable,
        async (writer) => {
          async function lockTenant(mode: "UPDATE" | "KEY SHARE") {
            const row = await writer.query(`SELECT id FROM organization WHERE id=$1 FOR ${mode}`, [
              f.orgId,
            ]);
            expect(row.rowCount).toBe(1);
          }
          async function lockAdaptation() {
            const row = await writer.query(
              "SELECT id FROM adaptations WHERE org_id=$1 AND content_item_id=$2 AND id=$3 FOR UPDATE",
              [f.orgId, f.itemId, f.adaptationId],
            );
            expect(row.rowCount).toBe(1);
          }
          async function lockItem(mode: "UPDATE" | "SHARE" = "UPDATE") {
            const row = await writer.query(
              `SELECT id FROM content_items WHERE org_id=$1 AND id=$2 FOR ${mode}`,
              [f.orgId, f.itemId],
            );
            expect(row.rowCount).toBe(1);
          }
          if (memberRace) {
            const changed =
              kind === "member removal"
                ? await writer.query("DELETE FROM member WHERE organization_id=$1 AND user_id=$2", [
                    f.orgId,
                    f.userId,
                  ])
                : await writer.query(
                    "UPDATE member SET role='author' WHERE organization_id=$1 AND user_id=$2",
                    [f.orgId, f.userId],
                  );
            expect(changed.rowCount).toBe(1);
            return;
          }
          if (kind === "organization deletion") {
            const removed = await writer.query("DELETE FROM organization WHERE id=$1", [f.orgId]);
            expect(removed.rowCount).toBe(1);
            return;
          }
          if (tenantRace) {
            await lockTenant("UPDATE");
            // Own unlink/session authority takes the user before the registry.
            if (kind === "binding revocation") {
              const user = await writer.query('SELECT id FROM "user" WHERE id=$1 FOR SHARE', [
                f.userId,
              ]);
              expect(user.rowCount).toBe(1);
            }
            const registry = await writer.query(
              "SELECT id FROM telegram_bot_identities WHERE id=$1 FOR UPDATE",
              [f.identityId],
            );
            expect(registry.rowCount).toBe(1);
            const config = await writer.query(
              "SELECT org_id FROM telegram_decision_configs WHERE org_id=$1 FOR UPDATE",
              [f.orgId],
            );
            expect(config.rowCount).toBe(1);
            if (kind === "bot disable") {
              await writer.query("UPDATE telegram_bot_identities SET enabled=false WHERE id=$1", [
                f.identityId,
              ]);
              await writer.query(
                "UPDATE telegram_decision_configs SET state='disabled' WHERE org_id=$1",
                [f.orgId],
              );
              await writer.query(
                "UPDATE telegram_bindings SET state='revoked',revoked_at=clock_timestamp() WHERE org_id=$1 AND state='linked'",
                [f.orgId],
              );
              await writer.query(
                "UPDATE telegram_initial_capabilities SET state='revoked',terminal_at=clock_timestamp() WHERE org_id=$1 AND state='pending'",
                [f.orgId],
              );
            } else {
              const changed = await writer.query(
                "UPDATE telegram_bindings SET state='revoked',revoked_at=clock_timestamp() WHERE org_id=$1 AND id=$2",
                [f.orgId, f.bindingId],
              );
              expect(changed.rowCount).toBe(1);
            }
            const changed = await writer.query(
              "UPDATE telegram_actor_confirmations SET state='revoked',terminal_at=clock_timestamp() WHERE org_id=$1 AND user_id=$2 AND state='pending'",
              [f.orgId, f.userId],
            );
            expect(changed.rowCount).toBe(1);
            return;
          }
          if (claimRace) {
            // The native claim storage suffix matches markPublishing's
            // adaptation UPDATE → item SHARE and incremented attempt evidence.
            await lockAdaptation();
            await lockItem("SHARE");
            const changed = await writer.query(
              "UPDATE adaptations SET status='publishing',attempt_count=attempt_count+1,failure_reason=NULL WHERE org_id=$1 AND id=$2 AND status='pending' AND scheduled_at IS NULL",
              [f.orgId, f.adaptationId],
            );
            expect(changed.rowCount).toBe(1);
            return;
          }
          await lockTenant("KEY SHARE");
          if (kind === "raw item deletion") {
            // Public permanent deletion also requires an archived unsent item.
            // This raw SQL case proves cascade/decision safety, not that API gate.
            const brand = await writer.query(
              "SELECT id FROM brands WHERE org_id=$1 AND id=$2 FOR UPDATE",
              [f.orgId, f.brandId],
            );
            expect(brand.rowCount).toBe(1);
            await lockAdaptation();
            await lockItem();
            const removed = await writer.query(
              "DELETE FROM content_items WHERE org_id=$1 AND id=$2",
              [f.orgId, f.itemId],
            );
            expect(removed.rowCount).toBe(1);
            return;
          }
          if (kind.startsWith("adaptation")) {
            await lockAdaptation();
            await lockItem();
            const changed =
              kind === "adaptation body"
                ? await writer.query("UPDATE adaptations SET body=$1 WHERE org_id=$2 AND id=$3", [
                    "Changed channel body",
                    f.orgId,
                    f.adaptationId,
                  ])
                : await writer.query(
                    "UPDATE adaptations SET body=$1,hashtags=$2::text[] WHERE org_id=$3 AND id=$4",
                    [withHashtags(before.body, ["changed"]), ["changed"], f.orgId, f.adaptationId],
                  );
            expect(changed.rowCount).toBe(1);
            return;
          }
          await lockItem();
          if (kind === "master video media") {
            const mediaId = randomUUID();
            await writer.query(
              "INSERT INTO media_assets(id,org_id,brand_id,name,kind,mime_type,byte_size) VALUES($1,$2,$3,'Synthetic race video','video','video/mp4',1)",
              [mediaId, f.orgId, f.brandId],
            );
            const changed = await writer.query(
              "UPDATE content_items SET video_media_id=$1 WHERE org_id=$2 AND id=$3",
              [mediaId, f.orgId, f.itemId],
            );
            expect(changed.rowCount).toBe(1);
          } else {
            const changed =
              kind === "master body"
                ? await writer.query("UPDATE content_items SET body=$1 WHERE org_id=$2 AND id=$3", [
                    "Changed master body",
                    f.orgId,
                    f.itemId,
                  ])
                : await writer.query(
                    "UPDATE content_items SET title=$1 WHERE org_id=$2 AND id=$3",
                    ["Changed master title", f.orgId, f.itemId],
                  );
            expect(changed.rowCount).toBe(1);
          }
        },
      );
      expect(response.status).toBe(200);
      const deletedTenant = kind === "organization deletion";
      const deletedItem = kind === "raw item deletion";
      expect(await status(f)).toEqual({
        status: deletedTenant || deletedItem ? undefined : "draft",
        audit: [],
      });
      const caps = await db
        .select({
          state: schema.telegramActorConfirmations.state,
          terminalAt: schema.telegramActorConfirmations.terminalAt,
        })
        .from(schema.telegramActorConfirmations)
        .where(eq(schema.telegramActorConfirmations.orgId, f.orgId));
      if (deletedTenant) expect(caps).toEqual([]);
      else if (kind === "bot disable" || kind === "binding revocation") {
        expect(caps).toHaveLength(1);
        expect(caps[0]?.state).toBe("revoked");
        expect(caps[0]?.terminalAt).toBeInstanceOf(Date);
      } else expect(caps).toEqual([{ state: "pending", terminalAt: null }]);
      const receipts = await db
        .select({ outcome: schema.telegramUpdateReceipts.outcome })
        .from(schema.telegramUpdateReceipts)
        .where(
          and(
            eq(schema.telegramUpdateReceipts.orgId, f.orgId),
            eq(schema.telegramUpdateReceipts.updateId, "2"),
          ),
        );
      if (deletedTenant || kind === "bot disable") expect(receipts).toEqual([]);
      else expect(receipts).toEqual([{ outcome: "refused" }]);
      if (kind.startsWith("master") || kind.startsWith("adaptation")) {
        const after = await readEditorialSnapshot(db, f.orgId, f.itemId);
        expect(after && hashEditorialSnapshot(after)).not.toBe(hashEditorialSnapshot(before));
      }
      if (claimRace) {
        const [adaptation] = await db
          .select({
            status: schema.adaptations.status,
            attemptCount: schema.adaptations.attemptCount,
          })
          .from(schema.adaptations)
          .where(eq(schema.adaptations.id, f.adaptationId));
        expect(adaptation).toEqual({ status: "publishing", attemptCount: 1 });
      }
      if (deletedTenant) {
        const [registry] = await db
          .select({
            ownerOrgId: schema.telegramBotIdentities.ownerOrgId,
            enabled: schema.telegramBotIdentities.enabled,
            quarantined: schema.telegramBotIdentities.quarantined,
          })
          .from(schema.telegramBotIdentities)
          .where(eq(schema.telegramBotIdentities.id, f.identityId));
        expect(registry).toEqual({ ownerOrgId: null, enabled: false, quarantined: true });
      }
      expect(await livePublishJobs(f)).toBe(false);
    },
  );
});
