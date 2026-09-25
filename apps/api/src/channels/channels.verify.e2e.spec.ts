import { createCipheriv, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import { telegramPublisher } from "@pubrick/integrations";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("channels verify e2e", () => {
  let app: INestApplication;
  let direct: ReturnType<typeof createDb>;
  let telegram: Server;
  const telegramCalls: string[] = [];

  // Sentinel chat id that makes the fake server return a malformed (but
  // envelope-valid) getChat response, so a single test can exercise the
  // "adapter misbehaves" path without disturbing the default fixtures used
  // by every other test.
  const MALFORMED_GET_CHAT_CHAT_ID = "-999999999999";

  beforeAll(async () => {
    telegram = createServer((req, res) => {
      telegramCalls.push(req.url ?? "");
      const method = (req.url ?? "").split("/").pop();
      if (req.url?.startsWith("/method/")) {
        const vkBodies: Record<string, unknown> = {
          "users.get": { response: [{ id: 7 }] },
          "account.getAppPermissions": { response: 8192 },
          "groups.getById": {
            response: { groups: [{ id: 12345, name: "Bakery", is_admin: 1 }] },
          },
        };
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(
            vkBodies[method ?? ""] ?? { error: { error_code: 3, error_msg: "unknown" } },
          ),
        );
        return;
      }
      if (req.url === "/me" || req.url?.startsWith("/chats/")) {
        const maxBodies: Record<string, unknown> = {
          "/me": { user_id: 7, username: "writer_bot" },
          "/chats/-12345": { chat_id: -12345, type: "channel", status: "active", title: "Bakery" },
          "/chats/-12345/members/me": { is_owner: false, is_admin: true, permissions: ["write"] },
        };
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(maxBodies[req.url ?? ""] ?? { code: "not_found", message: "Unknown" }),
        );
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        let chatId: string | undefined;
        try {
          chatId = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}").chat_id;
        } catch {
          chatId = undefined;
        }

        const bodies: Record<string, unknown> = {
          getMe: { ok: true, result: { id: 42, username: "my_bot" } },
          getChat:
            chatId === MALFORMED_GET_CHAT_CHAT_ID
              ? { ok: true, result: null }
              : { ok: true, result: { id: -1001234567890, type: "channel", title: "My Channel" } },
          getChatMember: { ok: true, result: { status: "administrator", can_post_messages: true } },
        };
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify(
            bodies[method ?? ""] ?? { ok: false, error_code: 400, description: "unknown" },
          ),
        );
      });
    });
    await new Promise<void>((resolve) => telegram.listen(0, resolve));
    const port = (telegram.address() as { port: number }).port;
    process.env.TELEGRAM_API_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.VK_API_BASE_URL = `http://127.0.0.1:${port}/method`;
    process.env.MAX_API_BASE_URL = `http://127.0.0.1:${port}`;

    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    // Migrations run once for the whole suite in vitest.global-setup.ts (a single
    // barrier, instead of six e2e files each racing runMigrations() against the
    // same DB — that redundant per-file migration dance is what caused the
    // "beforeAll hook timed out" flake).
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    // Listen for the whole file: supertest otherwise starts the server per
    // request and closes it when that request ends, killing any other request
    // in flight (see content.e2e.spec.ts for the measurement).
    await app.listen(0);
    direct = createDb(url as string);
  });

  afterAll(async () => {
    await app.close();
    await direct.pool.end();
    await new Promise<void>((resolve) => telegram.close(() => resolve()));
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

  it("verifies a telegram channel and never returns credentials", async () => {
    const agent = await orgAgent();
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

    const result = await agent.post(`/api/channels/${channel.body.id}/test`).send({}).expect(200);
    expect(result.body).toEqual({ ok: true, account: "@my_bot", target: "My Channel" });
    expect(JSON.stringify(result.body)).not.toContain("123:abc");
    expect(telegramCalls.some((u) => u.includes("getChatMember"))).toBe(true);
  });

  it("shows a scoped cached check and scheduled exposure, then invalidates it on rotation", async () => {
    const agent = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Health" }).expect(201);
    const created = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Health channel",
        credentials: { botToken: "123:abc", chatId: "-1001234567890" },
      })
      .expect(201);
    const id = created.body.id as string;
    const [brandRow] = await direct.db
      .select({ orgId: schema.brands.orgId })
      .from(schema.brands)
      .where(eq(schema.brands.id, brand.body.id));
    if (!brandRow) throw new Error("brand lookup failed");
    const [post] = await direct.db
      .insert(schema.contentItems)
      .values({ orgId: brandRow.orgId, brandId: brand.body.id, body: "Ready", status: "approved" })
      .returning({ id: schema.contentItems.id });
    if (!post) throw new Error("post insert failed");
    await direct.db.insert(schema.adaptations).values({
      orgId: brandRow.orgId,
      contentItemId: post.id,
      channelId: id,
      status: "scheduled",
      scheduledAt: new Date(Date.now() + 60_000),
    });

    await agent.post(`/api/channels/${id}/test`).send({}).expect(200);
    const [checked] = (await agent.get(`/api/channels?brandId=${brand.body.id}`).expect(200)).body;
    expect(checked.health.state).toBe("ok");
    expect(checked.health.checkedAt).toBeTruthy();
    expect(checked.scheduledCount).toBe(1);
    expect(JSON.stringify(checked)).not.toContain("123:abc");

    await agent
      .patch(`/api/channels/${id}`)
      .send({ credentials: { botToken: "123:new", chatId: "-1001234567890" } })
      .expect(200);
    const [rotated] = (await agent.get(`/api/channels?brandId=${brand.body.id}`).expect(200)).body;
    expect(rotated.health).toEqual({ state: "unknown", checkedAt: null });
    expect(rotated.scheduledCount).toBe(1);
    const outsider = await orgAgent();
    expect((await outsider.get("/api/channels").expect(200)).body).toEqual([]);
  });

  it("does not cache a manual Test answer for credentials rotated while it ran", async () => {
    const agent = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Race" }).expect(201);
    const created = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Race channel",
        credentials: { botToken: "123:old", chatId: "-1001234567890" },
      })
      .expect(201);
    const id = created.body.id as string;
    let started!: () => void;
    let release!: () => void;
    const checking = new Promise<void>((resolve) => {
      started = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = vi.spyOn(telegramPublisher, "verify").mockImplementation(async () => {
      started();
      await hold;
      return { ok: true, account: "@old", target: "Old channel" };
    });
    try {
      const test = Promise.resolve(agent.post(`/api/channels/${id}/test`).send({}).expect(200));
      await checking;
      await agent
        .patch(`/api/channels/${id}`)
        .send({ credentials: { botToken: "123:new", chatId: "-1001234567890" } })
        .expect(200);
      release();
      expect((await test).body.ok).toBe(true);
      const [listed] = (await agent.get(`/api/channels?brandId=${brand.body.id}`).expect(200)).body;
      expect(listed.health).toEqual({ state: "unknown", checkedAt: null });
    } finally {
      release();
      spy.mockRestore();
    }
  });

  it("returns a successful manual Test even if the advisory cache write fails", async () => {
    const agent = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "Cache failure" }).expect(201);
    const created = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Cache failure channel",
        credentials: { botToken: "123:abc", chatId: "-1001234567890" },
      })
      .expect(201);
    const [brandRow] = await direct.db
      .select({ orgId: schema.brands.orgId })
      .from(schema.brands)
      .where(eq(schema.brands.id, brand.body.id));
    if (!brandRow) throw new Error("brand lookup failed");
    const { db } = await import("../db");
    const { ChannelsRepository } = await import("./channels.repository");
    const cacheWrite = vi.spyOn(db, "update").mockImplementationOnce(() => {
      throw new Error("cache write unavailable");
    });
    try {
      expect(await app.get(ChannelsRepository).verify(brandRow.orgId, created.body.id)).toEqual({
        ok: true,
        account: "@my_bot",
        target: "My Channel",
      });
      expect(cacheWrite).toHaveBeenCalledTimes(1);
    } finally {
      cacheWrite.mockRestore();
    }
  });

  it("verifies a VK community through the API without exposing its token", async () => {
    const agent = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "B" }).expect(201);
    const channel = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "vk",
        name: "VK",
        credentials: { accessToken: "vk-api-secret", groupId: "12345" },
      })
      .expect(201);
    const result = await agent.post(`/api/channels/${channel.body.id}/test`).send({}).expect(200);
    expect(result.body).toEqual({ ok: true, account: "id7", target: "Bakery" });
    expect(JSON.stringify(result.body)).not.toContain("vk-api-secret");
    expect(telegramCalls).toContain("/method/groups.getById");
  });

  it("verifies a MAX channel through the API without exposing its token", async () => {
    const agent = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "B" }).expect(201);
    const channel = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "max",
        name: "MAX",
        credentials: { accessToken: "max-api-secret", chatId: "-12345" },
      })
      .expect(201);
    const result = await agent.post(`/api/channels/${channel.body.id}/test`).send({}).expect(200);
    expect(result.body).toEqual({ ok: true, account: "@writer_bot", target: "Bakery" });
    expect(JSON.stringify(result.body)).not.toContain("max-api-secret");
    expect(telegramCalls).toContain("/chats/-12345/members/me");
  });

  it("answers 200 with ok:false, not a 500, when the adapter gets a malformed platform response", async () => {
    const agent = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "B" }).expect(201);
    const channel = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Malformed",
        credentials: { botToken: "123:abc", chatId: MALFORMED_GET_CHAT_CHAT_ID },
      })
      .expect(201);

    const result = await agent.post(`/api/channels/${channel.body.id}/test`).send({}).expect(200);
    expect(result.body.ok).toBe(false);
    expect(typeof result.body.reason).toBe("string");
    expect(JSON.stringify(result.body)).not.toContain("123:abc");
  });

  it("leaves a pre-envelope row byte-identical under a single key, so a worker on the previous build still reads it", async () => {
    // This app boots on ONE key — the ring every existing install runs — and
    // its rows are `base64(iv || tag || ciphertext)` with no version and no key
    // id, written by the code before the ring existed. `channels.credentials.e2e`
    // proves the mirror image on a two-key ring: there, Test MOVES this row.
    // Here it must not, because the only thing a rewrap could change is the
    // format, and the previous build's worker reads only this one. The blob is
    // written out by hand rather than through a helper the reader could drift
    // with.
    const agent = await orgAgent();
    const brand = await agent.post("/api/brands").send({ name: "B" }).expect(201);
    const created = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Old rows",
        credentials: { botToken: "123:abc", chatId: "-1001234567890" },
      })
      .expect(201);
    const id = created.body.id as string;
    const key = Buffer.from(process.env.APP_ENCRYPTION_KEY as string, "base64");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify({ botToken: "123:abc", chatId: "-1001234567890" }), "utf8"),
      cipher.final(),
    ]);
    const legacy = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
    expect(legacy).not.toContain(".");
    await direct.db
      .update(schema.channels)
      .set({ credentialsEncrypted: legacy })
      .where(eq(schema.channels.id, id));

    const result = await agent.post(`/api/channels/${id}/test`).send({}).expect(200);
    expect(result.body.ok).toBe(true);

    const rows = await direct.db
      .select({ credentialsEncrypted: schema.channels.credentialsEncrypted })
      .from(schema.channels)
      .where(eq(schema.channels.id, id));
    expect(rows[0]?.credentialsEncrypted).toBe(legacy);
  });

  it("404s for another organization's channel", async () => {
    const a = await orgAgent();
    const b = await orgAgent();
    const brand = await a.post("/api/brands").send({ name: "B" }).expect(201);
    const channel = await a
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "M",
        credentials: { botToken: "1:a", chatId: "-100" },
      })
      .expect(201);
    await b.post(`/api/channels/${channel.body.id}/test`).send({}).expect(404);
  });
});
