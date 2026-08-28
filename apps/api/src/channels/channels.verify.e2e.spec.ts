import { createServer, type Server } from "node:http";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("channels verify e2e", () => {
  let app: INestApplication;
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
  });

  afterAll(async () => {
    await app.close();
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
