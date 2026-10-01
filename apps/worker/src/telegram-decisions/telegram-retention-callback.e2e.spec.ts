import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createServer as createPortServer } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createDb, hashEditorialSnapshot, readEditorialSnapshot, schema } from "@pubrick/db";
import { encryptJson } from "@pubrick/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TelegramRetentionRepository } from "./telegram-retention.repository";

const url = process.env.TEST_DATABASE_URL;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const originalDatabaseUrl = process.env.DATABASE_URL;
const apiDirectory = resolve(__dirname, "../../../api");

// This native suite requires `pnpm exec turbo run build --filter=@pubrick/api...`
// beforehand. A requested native run fails if the compiled API is missing; it
// never substitutes a mock domain writer or silently skips the overlap proof.
describe.skipIf(!url)("native retention overlapping the actual final Telegram callback", () => {
  let connection: ReturnType<typeof createDb> | undefined;
  let repository: TelegramRetentionRepository;
  let api: ChildProcess | undefined;
  let provider: Server | undefined;
  let temporary: string | undefined;
  let origin: string;
  let output = "";
  const key = randomBytes(32).toString("base64");
  const marker = `synthetic-retention-callback-${randomUUID()}`;
  const orgIds: string[] = [];
  const userIds: string[] = [];
  const identityIds: string[] = [];
  const tokens = new Set<string>();
  const providerCalls: string[] = [];
  const unexpected: string[] = [];

  function native() {
    if (!connection) throw new Error("Missing owned native connection");
    return connection;
  }
  async function freePort() {
    const socket = createPortServer();
    await new Promise<void>((accept, reject) => {
      socket.once("error", reject);
      socket.listen(0, "127.0.0.1", accept);
    });
    const address = socket.address();
    if (!address || typeof address === "string") throw new Error("Missing loopback port");
    await new Promise<void>((accept, reject) => socket.close((e) => (e ? reject(e) : accept())));
    return address.port;
  }
  async function stopApi() {
    if (!api || api.exitCode !== null || api.signalCode !== null) return;
    const child = api;
    const exited = new Promise<void>((accept) => child.once("exit", () => accept()));
    const signal = (name: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, name);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    signal("SIGTERM");
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<void>((accept) => {
          timer = setTimeout(accept, 5000);
        }),
      ]);
      if (child.exitCode === null && child.signalCode === null) {
        signal("SIGKILL");
        await exited;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  beforeAll(async () => {
    if (!url || !/^pubrick_[a-zA-Z0-9_]+_test$/.test(new URL(url).pathname.slice(1)))
      throw new Error(
        "Retention/callback proof requires an explicitly disposable pubrick_*_test DB",
      );
    try {
      await access(resolve(apiDirectory, "dist/main.js"));
    } catch {
      throw new Error(
        "Build compiled API first: pnpm exec turbo run build --filter=@pubrick/api...",
      );
    }
    process.env.DATABASE_URL = url;
    connection = createDb(url, { max: 6, connectionTimeoutMillis: 5000 });
    repository = new (
      await import("./telegram-retention.repository")
    ).TelegramRetentionRepository();
    temporary = await mkdtemp(resolve(tmpdir(), "pubrick-retention-callback-"));
    provider = createServer(async (incoming, outgoing) => {
      const match = /^\/bot([^/]+)\/(answerCallbackQuery)$/.exec(incoming.url ?? "");
      if (incoming.method !== "POST" || !match?.[1] || !tokens.has(match[1])) {
        unexpected.push("unexpected_provider_operation");
        outgoing.writeHead(400).end(JSON.stringify({ ok: false, error_code: 400 }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as { callback_query_id?: string };
        if (!body.callback_query_id?.startsWith(marker)) throw new Error("Foreign callback answer");
        providerCalls.push(body.callback_query_id);
        outgoing.setHeader("content-type", "application/json");
        outgoing.end(JSON.stringify({ ok: true, result: true }));
      } catch {
        unexpected.push("invalid_provider_answer");
        outgoing.writeHead(400).end(JSON.stringify({ ok: false, error_code: 400 }));
      }
    });
    await new Promise<void>((accept, reject) => {
      provider?.once("error", reject);
      provider?.listen(0, "127.0.0.1", accept);
    });
    const providerAddress = provider.address();
    if (!providerAddress || typeof providerAddress === "string")
      throw new Error("Missing provider");
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    // Do not import API modules into the worker Vitest environment. Its module
    // singletons, auth, queue and env belong entirely to this child process.
    api = spawn(process.execPath, ["dist/main.js"], {
      cwd: apiDirectory,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        NODE_ENV: "test",
        DATABASE_URL: url,
        APP_ENCRYPTION_KEY: key,
        BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
        PUBRICK_DEPLOYMENT_MODE: "self-hosted",
        SIGNUP_MODE: "closed",
        AUTH_RATE_LIMIT_ENABLED: "false",
        WEB_ORIGIN: "https://pubrick.example.invalid",
        BETTER_AUTH_URL: origin,
        API_PORT: String(port),
        MEDIA_STORAGE_DIR: temporary,
        SMTP_HOST: "",
        SMTP_USER: "",
        SMTP_PASSWORD: "",
        SMTP_FROM: "",
        TELEGRAM_API_BASE_URL: `http://127.0.0.1:${providerAddress.port}`,
      },
    });
    api.stdout?.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-12000);
    });
    api.stderr?.on("data", (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-12000);
    });
    let startupError: Error | undefined;
    api.once("error", (error) => {
      startupError = error;
    });
    await vi.waitFor(
      async () => {
        if (startupError) throw startupError;
        if (api?.exitCode !== null || api?.signalCode !== null)
          throw new Error(`Compiled API exited before readiness: ${output}`);
        const response = await fetch(`${origin}/api/health`, {
          signal: AbortSignal.timeout(1000),
        });
        expect(response.ok).toBe(true);
      },
      { timeout: 60000, interval: 100 },
    );
  }, 90000);

  afterAll(async () => {
    try {
      await stopApi();
    } finally {
      try {
        if (provider) {
          provider.closeAllConnections();
          await new Promise<void>((accept, reject) =>
            provider?.close((e) => (e ? reject(e) : accept())),
          );
        }
      } finally {
        try {
          if (connection) {
            try {
              for (const orgId of orgIds)
                await connection.db
                  .delete(schema.organization)
                  .where(eq(schema.organization.id, orgId));
              for (const userId of userIds)
                await connection.db.delete(schema.user).where(eq(schema.user.id, userId));
              // Bot reservations deliberately survive tenant deletion. Keep
              // these opaque quarantined rows until this owned test DB is dropped.
              for (const identityId of identityIds) {
                const [reservation] = await connection.db
                  .select({
                    ownerOrgId: schema.telegramBotIdentities.ownerOrgId,
                    enabled: schema.telegramBotIdentities.enabled,
                    quarantined: schema.telegramBotIdentities.quarantined,
                  })
                  .from(schema.telegramBotIdentities)
                  .where(eq(schema.telegramBotIdentities.id, identityId));
                expect(reservation).toEqual({
                  ownerOrgId: null,
                  enabled: false,
                  quarantined: true,
                });
              }
            } finally {
              await connection.pool.end();
            }
          }
        } finally {
          try {
            if (connection) await (await import("../db")).pool.end();
          } finally {
            if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
            else process.env.DATABASE_URL = originalDatabaseUrl;
            if (temporary) await rm(temporary, { force: true, recursive: true });
          }
        }
      }
    }
  }, 30000);

  async function fixture() {
    const db = native().db;
    const orgId = randomUUID(),
      userId = randomUUID();
    orgIds.push(orgId);
    userIds.push(userId);
    await db.insert(schema.organization).values({ id: orgId, name: marker, slug: orgId });
    await db
      .insert(schema.user)
      .values({ id: userId, name: "Synthetic Editor", email: `${userId}@example.invalid` });
    await db
      .insert(schema.member)
      .values({ id: randomUUID(), organizationId: orgId, userId, role: "owner" });
    const botId = randomInt(100000, 1000000000),
      token = `${botId}:synthetic_retention_token`;
    tokens.add(token);
    const [bot] = await db
      .insert(schema.telegramBotIdentities)
      .values({ botId: String(botId), ownerOrgId: orgId, enabled: true })
      .returning();
    if (!bot) throw new Error("Missing bot");
    identityIds.push(bot.id);
    const routeId = randomBytes(32).toString("base64url"),
      secret = randomBytes(32).toString("base64url");
    await db.insert(schema.telegramDecisionConfigs).values({
      orgId,
      botIdentityId: bot.id,
      generation: 1,
      state: "active",
      routeId,
      secretHash: hash(secret),
      credentialsEncrypted: encryptJson({ botToken: token }, key),
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
        key,
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
      .values({ orgId, name: "Synthetic retention brand" })
      .returning();
    if (!brand || !binding) throw new Error("Missing actor/brand");
    const [item] = await db
      .insert(schema.contentItems)
      .values({
        orgId,
        brandId: brand.id,
        title: marker,
        body: "Synthetic unchanged draft.",
        isSafeToDelete: true,
      })
      .returning();
    const [channel] = await db
      .insert(schema.channels)
      .values({
        orgId,
        brandId: brand.id,
        name: "Synthetic channel",
        platform: "telegram",
        credentialsEncrypted: "synthetic-unused",
      })
      .returning();
    if (!item || !channel) throw new Error("Missing item/channel");
    await db
      .insert(schema.adaptations)
      .values({ orgId, contentItemId: item.id, channelId: channel.id });
    const snapshot = await readEditorialSnapshot(db, orgId, item.id);
    if (!snapshot) throw new Error("Missing snapshot");
    const snapshotHash = hashEditorialSnapshot(snapshot);
    const createdAt = new Date(),
      expiresAt = new Date(createdAt.getTime() + 20 * 60000);
    const [initial] = await db
      .insert(schema.telegramInitialCapabilities)
      .values({
        orgId,
        botIdentityId: bot.id,
        generation: 1,
        contentItemId: item.id,
        brandId: brand.id,
        snapshotHash,
        snapshotVersion: "client-review-v1",
        tokenHash: hash(randomBytes(32).toString("base64url")),
        chatId: "-10042",
        messageId: "100",
        sendState: "sent",
        sendAttemptedAt: createdAt,
        createdAt,
        expiresAt,
      })
      .returning();
    if (!initial) throw new Error("Missing initial");
    const code = randomBytes(32).toString("base64url");
    const [confirmation] = await db
      .insert(schema.telegramActorConfirmations)
      .values({
        orgId,
        userId,
        bindingId: binding.id,
        initialCapabilityId: initial.id,
        initialExpiresAt: expiresAt,
        botIdentityId: bot.id,
        generation: 1,
        contentItemId: item.id,
        brandId: brand.id,
        snapshotHash,
        snapshotVersion: "client-review-v1",
        tokenHash: hash(code),
        chatId: "777",
        messageId: "501",
        sendState: "sent",
        sendAttemptedAt: createdAt,
        createdAt,
        expiresAt,
      })
      .returning();
    if (!confirmation) throw new Error("Missing confirmation");
    const oldChallenge = randomUUID();
    await native().pool.query(
      `INSERT INTO telegram_binding_challenges (id,org_id,user_id,bot_identity_id,generation,code_hash,state,candidate_telegram_user_id,candidate_chat_id,candidate_display_name,created_at,claimed_at,expires_at) VALUES ($1,$2,$3,$4,1,$5,'awaiting_web_confirmation','778','778','Synthetic old candidate',statement_timestamp()-interval '2 days',statement_timestamp()-interval '2 days'+interval '1 minute',statement_timestamp()-interval '2 days'+interval '5 minutes')`,
      [oldChallenge, orgId, userId, bot.id, hash(randomUUID())],
    );
    await native().pool.query(
      `INSERT INTO telegram_update_receipts (org_id,bot_identity_id,update_id,generation,request_fingerprint,operation,outcome,accepted_at) VALUES ($1,$2,'900',1,$3,'binding_start','refused',statement_timestamp()-interval '8 days')`,
      [orgId, bot.id, hash(randomUUID())],
    );
    return {
      orgId,
      userId,
      botId,
      identityId: bot.id,
      bindingId: binding.id,
      itemId: item.id,
      channelId: channel.id,
      initialId: initial.id,
      confirmationId: confirmation.id,
      routeId,
      secret,
      code,
      oldChallenge,
    };
  }
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  function final(f: Fixture) {
    return fetch(`${origin}/api/telegram/webhook/${f.routeId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": f.secret },
      body: JSON.stringify({
        update_id: 2,
        callback_query: {
          id: `${marker}-${f.orgId}`,
          from: { id: 777, is_bot: false },
          data: `cr:${f.code}`,
          message: {
            message_id: 501,
            date: 1,
            from: { id: f.botId, is_bot: true },
            chat: { id: 777, type: "private" },
          },
        },
      }),
      signal: AbortSignal.timeout(15000),
    });
  }
  async function proof(f: Fixture) {
    const result = await native().pool.query(
      `SELECT
      (SELECT status FROM content_items WHERE id=$1) AS status,
      (SELECT first_opened_at FROM content_items WHERE id=$1) AS first_opened_at,
      (SELECT count(*)::int FROM telegram_decision_audit WHERE org_id=$2 AND content_item_id=$1 AND actor_user_id=$3 AND capability_id=$4 AND outcome='rejected') AS audits,
      (SELECT state FROM telegram_actor_confirmations WHERE id=$4) AS confirmation,
      (SELECT count(*)::int FROM telegram_initial_capabilities WHERE id=$5) AS live_initial,
      (SELECT count(*)::int FROM telegram_bindings WHERE id=$6 AND state='linked') AS binding,
      (SELECT count(*)::int FROM telegram_binding_challenges WHERE id=$7) AS old_challenge,
      (SELECT count(*)::int FROM telegram_update_receipts WHERE org_id=$2 AND update_id='900') AS old_receipt,
      (SELECT count(*)::int FROM telegram_update_receipts WHERE org_id=$2 AND update_id='2' AND operation='confirm_reject' AND outcome='accepted') AS accepted,
      (SELECT count(*)::int FROM usage_ledger WHERE org_id=$2) AS ledger,
      (SELECT count(*)::int FROM publications WHERE org_id=$2) AS publications`,
      [f.itemId, f.orgId, f.userId, f.confirmationId, f.initialId, f.bindingId, f.oldChallenge],
    );
    expect(result.rows[0]).toEqual({
      status: "rejected",
      first_opened_at: null,
      audits: 1,
      confirmation: "consumed",
      live_initial: 1,
      binding: 1,
      old_challenge: 0,
      old_receipt: 0,
      accepted: 1,
      ledger: 0,
      publications: 0,
    });
    expect(unexpected).toEqual([]);
    expect(providerCalls.filter((entry) => entry === `${marker}-${f.orgId}`)).toHaveLength(1);
  }

  it("skips the parent held by an actual final callback, then cleans siblings without losing its decision", async () => {
    const f = await fixture();
    const writer = await native().pool.connect();
    let pending: Promise<Response> | undefined;
    try {
      const pid = (await writer.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]
        ?.pid;
      await writer.query("BEGIN");
      await writer.query("SELECT id FROM channels WHERE id=$1 FOR UPDATE", [f.channelId]);
      let settled = false;
      pending = final(f).finally(() => {
        settled = true;
      });
      void pending.catch(() => undefined);
      await expect
        .poll(
          async () => {
            expect(settled, "final callback must wait on the actual channel writer").toBe(false);
            const wait = await native().pool.query(
              `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid)) AND query LIKE '%channels%') AS waiting`,
              [pid],
            );
            return wait.rows[0]?.waiting;
          },
          { timeout: 3000, interval: 10 },
        )
        .toBe(true);
      expect(await repository.sweepOrg(f.orgId)).toBe(0);
      expect(settled).toBe(false);
      await writer.query("COMMIT");
      expect((await pending).status).toBe(200);
      expect(await repository.sweepOrg(f.orgId)).toBe(2);
      await proof(f);
    } finally {
      await writer.query("ROLLBACK");
      await pending?.catch(() => undefined);
      writer.release();
    }
  });

  it("waits behind the real janitor transaction and applies once after its aged sibling cleanup", async () => {
    const f = await fixture();
    const barrier = await native().pool.connect();
    const suffix = randomBytes(8).toString("hex");
    const functionName = `retention_callback_barrier_${suffix}`;
    const triggerName = `retention_callback_barrier_${suffix}`;
    const lockKey = randomInt(1, 2147483647);
    let sweep: Promise<number> | undefined;
    let pending: Promise<Response> | undefined;
    try {
      const holder = (await barrier.query<{ pid: number }>("SELECT pg_backend_pid() AS pid"))
        .rows[0]?.pid;
      await barrier.query("SELECT pg_advisory_lock($1::int, 13)", [lockKey]);
      // A test-only scoped BEFORE DELETE barrier parks the genuine janitor after
      // its canonical parent/registry/child locks. It acquires no domain parents.
      // Extend only this transaction's lock timeout for deterministic observation.
      await native().pool.query(
        `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id = '${f.oldChallenge}'::uuid THEN PERFORM set_config('lock_timeout','5s',true); PERFORM pg_advisory_xact_lock(${lockKey},13); END IF; RETURN OLD; END $$`,
      );
      await native().pool.query(
        `CREATE TRIGGER ${triggerName} BEFORE DELETE ON telegram_binding_challenges FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
      );
      sweep = repository.sweepOrg(f.orgId);
      let sweepSettled = false;
      void sweep
        .finally(() => {
          sweepSettled = true;
        })
        .catch(() => undefined);
      let janitorPid: number | undefined;
      await expect
        .poll(
          async () => {
            expect(sweepSettled, "janitor must reach its actual DELETE barrier").toBe(false);
            const waits = await native().pool.query<{ pid: number }>(
              `SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid)) AND query LIKE '%DELETE FROM telegram_binding_challenges%'`,
              [holder],
            );
            janitorPid = waits.rows[0]?.pid;
            return Boolean(janitorPid);
          },
          { timeout: 1500, interval: 10 },
        )
        .toBe(true);
      let settled = false;
      pending = final(f).finally(() => {
        settled = true;
      });
      void pending.catch(() => undefined);
      await expect
        .poll(
          async () => {
            expect(settled, "actual final callback must wait behind janitor parent").toBe(false);
            const waits = await native().pool.query(
              `SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND $1::int=ANY(pg_blocking_pids(pid)) AND query LIKE '%organization%') AS waiting`,
              [janitorPid],
            );
            return waits.rows[0]?.waiting;
          },
          { timeout: 1500, interval: 10 },
        )
        .toBe(true);
      await barrier.query("SELECT pg_advisory_unlock($1::int,13)", [lockKey]);
      expect(await sweep).toBe(2);
      expect((await pending).status).toBe(200);
      expect(await repository.sweepOrg(f.orgId)).toBe(0);
      await proof(f);
    } finally {
      try {
        await barrier.query("SELECT pg_advisory_unlock($1::int,13)", [lockKey]);
        await sweep?.catch(() => undefined);
        await pending?.catch(() => undefined);
      } finally {
        try {
          await native().pool.query(
            `DROP TRIGGER IF EXISTS ${triggerName} ON telegram_binding_challenges`,
          );
        } finally {
          try {
            await native().pool.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
          } finally {
            barrier.release();
          }
        }
      }
    }
  });
});
