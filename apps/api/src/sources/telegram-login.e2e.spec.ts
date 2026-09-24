import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schema } from "@pubrick/db";
import { decryptJson, encryptJson } from "@pubrick/shared";
import { beginTelegramLogin, submitTelegramCode, submitTelegramPassword } from "@pubrick/telegram";
import { and, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@pubrick/telegram", () => ({
  beginTelegramLogin: vi.fn(),
  submitTelegramCode: vi.fn(),
  submitTelegramPassword: vi.fn(),
  resolveJoinedPrivateChannel: vi.fn(),
}));

const url = process.env.TEST_DATABASE_URL;
const phone = "+15551234567";
const code = "12345";
const password = "correct-horse-battery-staple";

describe.skipIf(!url)("Telegram source account login", () => {
  let app: INestApplication;
  let db: typeof import("../db")["db"];

  beforeEach(() => {
    vi.mocked(beginTelegramLogin).mockReset();
    vi.mocked(submitTelegramCode).mockReset();
    vi.mocked(submitTelegramPassword).mockReset();
  });

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    process.env.TELEGRAM_API_ID = "12345";
    process.env.TELEGRAM_API_HASH = "test-hash";
    db = (await import("../db")).db;
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function orgAgent() {
    const agent = request.agent(app.getHttpServer());
    const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const signup = await agent
      .post("/api/auth/sign-up/email")
      .send({
        email: `telegram-login-${uniq}@example.com`,
        password: "password1234",
        name: "Owner",
      })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${uniq}`, slug: `telegram-login-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return {
      agent,
      orgId: org.body.id as string,
      userId: signup.body.user.id as string,
    };
  }

  async function begin(agent: request.Agent) {
    vi.mocked(beginTelegramLogin).mockResolvedValueOnce({
      session: "unverified-session-secret",
      phoneCodeHash: "phone-hash-secret",
    });
    return agent.post("/api/sources/telegram-login/begin").send({ phone }).expect(201);
  }

  async function additionalAdmin(orgId: string) {
    const agent = request.agent(app.getHttpServer());
    const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    const signup = await agent
      .post("/api/auth/sign-up/email")
      .send({
        email: `telegram-admin-${uniq}@example.com`,
        password: "password1234",
        name: "Admin",
      })
      .expect(200);
    await db.insert(schema.member).values({
      id: randomUUID(),
      organizationId: orgId,
      userId: signup.body.user.id,
      role: "admin",
    });
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    return agent;
  }

  it("encrypts the challenge, keeps the prior session until verification, and disconnects without deleting sources", async () => {
    const { agent, orgId } = await orgAgent();
    const key = process.env.APP_ENCRYPTION_KEY as string;
    await db.insert(schema.telegramSourceAccounts).values({
      orgId,
      sessionEncrypted: encryptJson({ session: "old-session" }, key),
    });
    const brand = await agent.post("/api/brands").send({ name: "News brand" }).expect(201);
    const source = await agent
      .post("/api/sources")
      .send({
        brandId: brand.body.id,
        name: "Public channel",
        kind: "telegram",
        url: "https://t.me/sourcechannel",
      })
      .expect(201);
    const started = await begin(agent);
    expect(started.body).toMatchObject({
      connected: true,
      challenge: { stage: "code" },
    });
    const id = started.body.challenge.id as string;
    expect(JSON.stringify(started.body)).not.toContain(phone);
    expect(JSON.stringify(started.body)).not.toContain("unverified-session-secret");
    const [attempt] = await db
      .select({
        phoneEncrypted: schema.telegramLoginAttempts.phoneEncrypted,
        sessionEncrypted: schema.telegramLoginAttempts.sessionEncrypted,
        phoneCodeHashEncrypted: schema.telegramLoginAttempts.phoneCodeHashEncrypted,
      })
      .from(schema.telegramLoginAttempts)
      .where(eq(schema.telegramLoginAttempts.orgId, orgId));
    expect(JSON.stringify(attempt)).not.toContain(phone);
    expect(JSON.stringify(attempt)).not.toContain("unverified-session-secret");
    expect(JSON.stringify(attempt)).not.toContain("phone-hash-secret");
    expect(decryptJson(attempt?.phoneEncrypted as string, key)).toEqual({ phone });
    expect(decryptJson(attempt?.sessionEncrypted as string, key)).toEqual({
      session: "unverified-session-secret",
    });
    const [before] = await db
      .select({ sessionEncrypted: schema.telegramSourceAccounts.sessionEncrypted })
      .from(schema.telegramSourceAccounts)
      .where(eq(schema.telegramSourceAccounts.orgId, orgId));
    expect(decryptJson(before?.sessionEncrypted as string, key)).toEqual({
      session: "old-session",
    });
    vi.mocked(submitTelegramCode).mockResolvedValueOnce({
      status: "authorized",
      session: "verified-session-secret",
    });
    const connected = await agent
      .post("/api/sources/telegram-login/code")
      .send({ challengeId: id, code })
      .expect(201);
    expect(connected.body).toEqual({ status: "connected" });
    expect(submitTelegramCode).toHaveBeenCalledWith(
      { apiId: 12345, apiHash: "test-hash" },
      "unverified-session-secret",
      phone,
      "phone-hash-secret",
      code,
    );
    const [after] = await db
      .select({ sessionEncrypted: schema.telegramSourceAccounts.sessionEncrypted })
      .from(schema.telegramSourceAccounts)
      .where(eq(schema.telegramSourceAccounts.orgId, orgId));
    expect(JSON.stringify(after)).not.toContain("verified-session-secret");
    expect(decryptJson(after?.sessionEncrypted as string, key)).toEqual({
      session: "verified-session-secret",
    });
    const status = await agent.get("/api/sources/telegram-login").expect(200);
    expect(status.body).toEqual({ connected: true, challenge: null });
    expect((await agent.delete("/api/sources/telegram-connection").expect(200)).body).toEqual({
      connected: false,
    });
    expect((await agent.get("/api/sources/telegram-connection").expect(200)).body).toEqual({
      connected: false,
    });
    expect(
      (await agent.get(`/api/sources?brandId=${brand.body.id}`).expect(200)).body,
    ).toContainEqual(expect.objectContaining({ id: source.body.id }));
  });

  it("enforces owner role and organization ownership at every login step", async () => {
    const owner = await orgAgent();
    const other = await orgAgent();
    const started = await begin(owner.agent);
    const id = started.body.challenge.id as string;
    expect((await other.agent.get("/api/sources/telegram-login").expect(200)).body).toEqual({
      connected: false,
      challenge: null,
    });
    const crossed = await other.agent
      .post("/api/sources/telegram-login/code")
      .send({ challengeId: id, code })
      .expect(409);
    expect(crossed.body.code).toBe("telegram_login_expired");
    expect(submitTelegramCode).not.toHaveBeenCalled();
    await db
      .update(schema.member)
      .set({ role: "member" })
      .where(
        and(eq(schema.member.organizationId, owner.orgId), eq(schema.member.userId, owner.userId)),
      );
    for (const response of [
      await owner.agent.get("/api/sources/telegram-login"),
      await owner.agent.post("/api/sources/telegram-login/begin").send({ phone }),
      await owner.agent.post("/api/sources/telegram-login/code").send({ challengeId: id, code }),
      await owner.agent
        .post("/api/sources/telegram-login/password")
        .send({ challengeId: id, password }),
      await owner.agent.delete("/api/sources/telegram-connection"),
    ]) {
      expect(response.status).toBe(403);
      expect(response.body.code).toBe("private_source_owner_required");
    }
    expect(submitTelegramCode).not.toHaveBeenCalled();
  });

  it("lets the initiating admin restart after cooldown without allowing another admin to preempt", async () => {
    const owner = await orgAgent();
    const admin = await additionalAdmin(owner.orgId);
    const first = await begin(owner.agent);
    const oldId = first.body.challenge.id as string;
    expect((await admin.get("/api/sources/telegram-login").expect(200)).body).toEqual({
      connected: false,
      challenge: null,
    });
    await db
      .update(schema.telegramLoginAttempts)
      .set({ lastBeginAt: new Date(Date.now() - 61_000) })
      .where(eq(schema.telegramLoginAttempts.orgId, owner.orgId));
    const denied = await admin
      .post("/api/sources/telegram-login/begin")
      .send({ phone })
      .expect(409);
    expect(denied.body.code).toBe("telegram_login_busy");
    expect(beginTelegramLogin).toHaveBeenCalledTimes(1);
    const restarted = await begin(owner.agent);
    expect(restarted.body.challenge.id).not.toBe(oldId);
    const stale = await owner.agent
      .post("/api/sources/telegram-login/code")
      .send({ challengeId: oldId, code })
      .expect(409);
    expect(stale.body.code).toBe("telegram_login_expired");
  });

  it("ends the challenge after five rejected verification attempts", async () => {
    const { agent, orgId } = await orgAgent();
    const id = (await begin(agent)).body.challenge.id as string;
    for (let attempt = 0; attempt < 5; attempt++) {
      await db
        .update(schema.telegramLoginAttempts)
        .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.telegramLoginAttempts.orgId, orgId));
      vi.mocked(submitTelegramCode).mockRejectedValueOnce(new Error("invalid_code"));
      const refused = await agent
        .post("/api/sources/telegram-login/code")
        .send({ challengeId: id, code })
        .expect(409);
      expect(refused.body.code).toBe(
        attempt === 4 ? "telegram_login_expired" : "telegram_login_invalid",
      );
    }
    const exhausted = await agent
      .post("/api/sources/telegram-login/code")
      .send({ challengeId: id, code })
      .expect(409);
    expect(exhausted.body.code).toBe("telegram_login_expired");
    expect(submitTelegramCode).toHaveBeenCalledTimes(5);
    const [stored] = await db
      .select({
        stage: schema.telegramLoginAttempts.stage,
        sessionEncrypted: schema.telegramLoginAttempts.sessionEncrypted,
        phoneCodeHashEncrypted: schema.telegramLoginAttempts.phoneCodeHashEncrypted,
      })
      .from(schema.telegramLoginAttempts)
      .where(eq(schema.telegramLoginAttempts.orgId, orgId));
    expect(stored).toEqual({
      stage: "failed",
      sessionEncrypted: null,
      phoneCodeHashEncrypted: null,
    });
  });

  it("redacts expired challenge secrets in a bounded cleanup without touching a live challenge", async () => {
    const expired = await orgAgent();
    const live = await orgAgent();
    await begin(expired.agent);
    await begin(live.agent);
    await db
      .update(schema.telegramLoginAttempts)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.telegramLoginAttempts.orgId, expired.orgId));
    const { TelegramLoginRepository } = await import("./telegram-login.repository");
    await app.get(TelegramLoginRepository).cleanupExpired();
    const [redacted] = await db
      .select({
        stage: schema.telegramLoginAttempts.stage,
        phoneEncrypted: schema.telegramLoginAttempts.phoneEncrypted,
        sessionEncrypted: schema.telegramLoginAttempts.sessionEncrypted,
        phoneCodeHashEncrypted: schema.telegramLoginAttempts.phoneCodeHashEncrypted,
      })
      .from(schema.telegramLoginAttempts)
      .where(eq(schema.telegramLoginAttempts.orgId, expired.orgId));
    expect(redacted?.stage).toBe("complete");
    expect(
      decryptJson(redacted?.phoneEncrypted as string, process.env.APP_ENCRYPTION_KEY as string),
    ).toEqual({ phone: "redacted" });
    expect(redacted?.sessionEncrypted).toBeNull();
    expect(redacted?.phoneCodeHashEncrypted).toBeNull();
    const [preserved] = await db
      .select({
        stage: schema.telegramLoginAttempts.stage,
        phoneEncrypted: schema.telegramLoginAttempts.phoneEncrypted,
        sessionEncrypted: schema.telegramLoginAttempts.sessionEncrypted,
        phoneCodeHashEncrypted: schema.telegramLoginAttempts.phoneCodeHashEncrypted,
      })
      .from(schema.telegramLoginAttempts)
      .where(eq(schema.telegramLoginAttempts.orgId, live.orgId));
    expect(preserved?.stage).toBe("code");
    expect(
      decryptJson(preserved?.phoneEncrypted as string, process.env.APP_ENCRYPTION_KEY as string),
    ).toEqual({ phone });
    expect(preserved?.sessionEncrypted).not.toBeNull();
    expect(preserved?.phoneCodeHashEncrypted).not.toBeNull();
  });

  it("starts a periodic cleanup and stops its timer on shutdown", async () => {
    const { TelegramLoginRepository } = await import("./telegram-login.repository");
    const repository = new TelegramLoginRepository();
    const cleanup = vi.spyOn(repository, "cleanupExpired").mockResolvedValue();
    let tick: (() => void) | undefined;
    const timer = { unref: vi.fn() } as unknown as ReturnType<typeof setInterval>;
    const setTimer = vi.spyOn(globalThis, "setInterval").mockImplementation((callback, delay) => {
      expect(delay).toBe(60_000);
      tick = callback as () => void;
      return timer;
    });
    const clearTimer = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
    try {
      repository.onModuleInit();
      expect(cleanup).toHaveBeenCalledTimes(1);
      await new Promise<void>((resolve) => setImmediate(resolve));
      tick?.();
      expect(cleanup).toHaveBeenCalledTimes(2);
      repository.onModuleDestroy();
      expect(clearTimer).toHaveBeenCalledWith(timer);
    } finally {
      setTimer.mockRestore();
      clearTimer.mockRestore();
    }
  });

  it("handles invalid codes, verification cooldown, 2FA, and encrypted password state", async () => {
    const { agent, orgId } = await orgAgent();
    const started = await begin(agent);
    const id = started.body.challenge.id as string;
    vi.mocked(submitTelegramCode).mockRejectedValueOnce(new Error(`invalid_code ${code}`));
    // The transport maps provider errors to fixed codes; even an unexpected
    // message must not be reflected to a client.
    const unavailable = await agent
      .post("/api/sources/telegram-login/code")
      .send({ challengeId: id, code })
      .expect(409);
    expect(unavailable.body.code).toBe("telegram_login_unavailable");
    expect(JSON.stringify(unavailable.body)).not.toContain(code);
    const cooldown = await agent
      .post("/api/sources/telegram-login/code")
      .send({ challengeId: id, code })
      .expect(409);
    expect(cooldown.body.code).toBe("telegram_login_cooldown");
    await db
      .update(schema.telegramLoginAttempts)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.telegramLoginAttempts.orgId, orgId));
    vi.mocked(submitTelegramCode).mockRejectedValueOnce(new Error("invalid_code"));
    const invalid = await agent
      .post("/api/sources/telegram-login/code")
      .send({ challengeId: id, code })
      .expect(409);
    expect(invalid.body.code).toBe("telegram_login_invalid");
    await db
      .update(schema.telegramLoginAttempts)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.telegramLoginAttempts.orgId, orgId));
    vi.mocked(submitTelegramCode).mockResolvedValueOnce({
      status: "password_required",
      session: "password-stage-session",
    });
    const needsPassword = await agent
      .post("/api/sources/telegram-login/code")
      .send({ challengeId: id, code })
      .expect(201);
    expect(needsPassword.body).toMatchObject({
      status: "password_required",
      challenge: { id, stage: "password" },
    });
    expect(JSON.stringify(needsPassword.body)).not.toContain("password-stage-session");
    const [attempt] = await db
      .select({ sessionEncrypted: schema.telegramLoginAttempts.sessionEncrypted })
      .from(schema.telegramLoginAttempts)
      .where(eq(schema.telegramLoginAttempts.orgId, orgId));
    expect(JSON.stringify(attempt)).not.toContain("password-stage-session");
    vi.mocked(submitTelegramPassword).mockRejectedValueOnce(new Error("invalid_password"));
    const wrong = await agent
      .post("/api/sources/telegram-login/password")
      .send({ challengeId: id, password })
      .expect(409);
    expect(wrong.body.code).toBe("telegram_login_invalid");
    expect(JSON.stringify(wrong.body)).not.toContain(password);
    await db
      .update(schema.telegramLoginAttempts)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.telegramLoginAttempts.orgId, orgId));
    vi.mocked(submitTelegramPassword).mockResolvedValueOnce({ session: "fully-verified-session" });
    expect(
      (
        await agent
          .post("/api/sources/telegram-login/password")
          .send({ challengeId: id, password })
          .expect(201)
      ).body,
    ).toEqual({ status: "connected" });
    expect(submitTelegramPassword).toHaveBeenCalledWith(
      { apiId: 12345, apiHash: "test-hash" },
      "password-stage-session",
      password,
    );
  });

  it("allows 2FA when the fifth code attempt succeeds", async () => {
    const { agent, orgId } = await orgAgent();
    const id = (await begin(agent)).body.challenge.id as string;
    for (let attempt = 0; attempt < 4; attempt++) {
      await db
        .update(schema.telegramLoginAttempts)
        .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.telegramLoginAttempts.orgId, orgId));
      vi.mocked(submitTelegramCode).mockRejectedValueOnce(new Error("invalid_code"));
      const refused = await agent
        .post("/api/sources/telegram-login/code")
        .send({ challengeId: id, code })
        .expect(409);
      expect(refused.body.code).toBe("telegram_login_invalid");
    }
    await db
      .update(schema.telegramLoginAttempts)
      .set({ nextAttemptAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.telegramLoginAttempts.orgId, orgId));
    vi.mocked(submitTelegramCode).mockResolvedValueOnce({
      status: "password_required",
      session: "fifth-code-session",
    });
    const fifth = await agent
      .post("/api/sources/telegram-login/code")
      .send({ challengeId: id, code })
      .expect(201);
    expect(fifth.body.status).toBe("password_required");
    const [passwordStage] = await db
      .select({
        stage: schema.telegramLoginAttempts.stage,
        attemptsUsed: schema.telegramLoginAttempts.attemptsUsed,
      })
      .from(schema.telegramLoginAttempts)
      .where(eq(schema.telegramLoginAttempts.orgId, orgId));
    expect(passwordStage).toEqual({ stage: "password", attemptsUsed: 0 });
    vi.mocked(submitTelegramPassword).mockResolvedValueOnce({ session: "verified-2fa-session" });
    const connected = await agent
      .post("/api/sources/telegram-login/password")
      .send({ challengeId: id, password })
      .expect(201);
    expect(connected.body).toEqual({ status: "connected" });
    expect(submitTelegramPassword).toHaveBeenCalledTimes(1);
  });

  it("expires challenges and admits only one concurrent code send", async () => {
    const first = await orgAgent();
    vi.mocked(beginTelegramLogin).mockResolvedValue({
      session: "concurrent-session",
      phoneCodeHash: "concurrent-hash",
    });
    const [a, b] = await Promise.all([
      first.agent.post("/api/sources/telegram-login/begin").send({ phone }),
      first.agent.post("/api/sources/telegram-login/begin").send({ phone }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(beginTelegramLogin).toHaveBeenCalledTimes(1);
    const id = (a.status === 201 ? a.body : b.body).challenge.id as string;
    await db
      .update(schema.telegramLoginAttempts)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.telegramLoginAttempts.orgId, first.orgId));
    const expired = await first.agent
      .post("/api/sources/telegram-login/code")
      .send({ challengeId: id, code })
      .expect(409);
    expect(expired.body.code).toBe("telegram_login_expired");
    expect(submitTelegramCode).not.toHaveBeenCalled();
  });

  it("does not reconnect after disconnect wins a verification race", async () => {
    const { agent, orgId } = await orgAgent();
    const id = (await begin(agent)).body.challenge.id as string;
    let release: ((value: { status: "authorized"; session: string }) => void) | undefined;
    vi.mocked(submitTelegramCode).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = agent
      .post("/api/sources/telegram-login/code")
      .send({ challengeId: id, code })
      .then((response) => response);
    await vi.waitFor(() => expect(release).toBeDefined());
    await agent.delete("/api/sources/telegram-connection").expect(200);
    release?.({ status: "authorized", session: "must-not-connect" });
    const refused = await pending;
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("telegram_login_expired");
    const rows = await db
      .select({ orgId: schema.telegramSourceAccounts.orgId })
      .from(schema.telegramSourceAccounts)
      .where(eq(schema.telegramSourceAccounts.orgId, orgId));
    expect(rows).toEqual([]);
  });
});
