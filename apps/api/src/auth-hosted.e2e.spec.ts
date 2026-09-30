import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("hosted ownership against real auth storage and local SMTP", () => {
  let app: INestApplication;
  let smtp: SMTPServer;
  let smtpClosed = false;
  const messages: Array<{ to: string; body: string }> = [];
  const password = "hosted-password123";
  const origin = "http://localhost:3000";
  const fresh = (label: string) =>
    `${label}-${Date.now()}-${Math.floor(Math.random() * 1e8)}@example.com`;
  const headers = (ip: string) => ({
    Origin: origin,
    "X-Forwarded-For": ip,
    "x-pubrick-locale": "en",
  });
  beforeAll(async () => {
    smtp = new SMTPServer({
      disabledCommands: ["STARTTLS"],
      allowInsecureAuth: true,
      logger: false,
      onAuth(auth, _session, callback) {
        callback(
          auth.username === "account" && auth.password === "disposable"
            ? null
            : new Error("Rejected"),
          { user: "account" },
        );
      },
      onData(stream, session, callback) {
        let body = "";
        stream.on("data", (chunk) => {
          body += chunk.toString();
        });
        stream.on("end", () => {
          messages.push({ to: session.envelope.rcptTo[0].address, body });
          callback();
        });
      },
    });
    await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
    const address = smtp.server.address();
    if (!address || typeof address === "string") throw new Error("Missing local SMTP port");
    Object.assign(process.env, {
      DATABASE_URL: databaseUrl,
      PUBRICK_DEPLOYMENT_MODE: "hosted",
      SIGNUP_MODE: "open",
      AUTH_RATE_LIMIT_ENABLED: "true",
      TRUSTED_PROXIES: "127.0.0.1,::1",
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(address.port),
      SMTP_USER: "account",
      SMTP_PASSWORD: "disposable",
      SMTP_FROM: "pubrick@example.com",
      SMTP_SECURE: "false",
      SMTP_REQUIRE_TLS: "false",
      WEB_ORIGIN: origin,
      BETTER_AUTH_URL: origin,
    });
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const { AppModule } = await import("./app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  });
  afterAll(async () => {
    await app?.close();
    if (smtp && !smtpClosed) await new Promise<void>((resolve) => smtp.close(resolve));
  });
  async function emailLink(email: string, part: string) {
    await (await import("./auth")).authMailer?.drain();
    const message = [...messages]
      .reverse()
      .find((entry) => entry.to === email && entry.body.includes(part));
    expect(message).toBeDefined();
    const parsed = await simpleParser(message?.body ?? "");
    const link = parsed.text?.split(/\r?\n/).find((line) => line.startsWith(`${origin}/api/auth/`));
    expect(link).toBeDefined();
    return new URL(link as string);
  }
  async function verify(email: string) {
    const link = await emailLink(email, "verify-email");
    expect(link.origin).toBe(origin);
    await request(app.getHttpServer())
      .get(link.pathname + link.search)
      .expect(302);
  }
  it("does not issue a session before email ownership, then supports verified invitations and one-use password recovery", async () => {
    const owner = request.agent(app.getHttpServer());
    const ownerEmail = fresh("owner");
    const sourceHeaders = headers("192.0.2.10");
    const signup = await owner
      .post("/api/auth/sign-up/email")
      .set(sourceHeaders)
      .send({
        email: ownerEmail,
        password,
        name: "Owner",
        callbackURL: `${origin}/en/verify-email`,
      })
      .expect(200);
    expect(signup.body.token).toBeNull();
    expect(
      (await owner.get("/api/auth/get-session").set(sourceHeaders).expect(200)).body,
    ).toBeNull();
    await owner
      .post("/api/auth/sign-in/email")
      .set(sourceHeaders)
      .send({ email: ownerEmail, password })
      .expect(403);
    await verify(ownerEmail);
    await owner
      .post("/api/auth/sign-in/email")
      .set(sourceHeaders)
      .send({ email: ownerEmail, password })
      .expect(200);
    const organization = await owner
      .post("/api/auth/organization/create")
      .set(sourceHeaders)
      .send({ name: "Hosted identity", slug: `hosted-${Date.now()}` })
      .expect(200);
    const memberEmail = fresh("member");
    const invitation = await owner
      .post("/api/auth/organization/invite-member")
      .set(sourceHeaders)
      .send({ email: memberEmail, role: "member", organizationId: organization.body.id })
      .expect(200);
    await (await import("./auth")).authMailer?.drain();
    expect(
      messages.some(
        (message) => message.to === memberEmail && message.body.includes("/en/onboarding"),
      ),
    ).toBe(true);
    const member = request.agent(app.getHttpServer());
    const memberHeaders = headers("192.0.2.11");
    await member
      .post("/api/auth/sign-up/email")
      .set(memberHeaders)
      .send({ email: memberEmail, password, name: "Member" })
      .expect(200);
    await member
      .post("/api/auth/organization/accept-invitation")
      .set(memberHeaders)
      .send({ invitationId: invitation.body.id })
      .expect(401);
    await verify(memberEmail);
    await member
      .post("/api/auth/sign-in/email")
      .set(memberHeaders)
      .send({ email: memberEmail, password })
      .expect(200);
    await member
      .post("/api/auth/organization/accept-invitation")
      .set(memberHeaders)
      .send({ invitationId: invitation.body.id })
      .expect(200);
    const known = await owner
      .post("/api/auth/request-password-reset")
      .set(sourceHeaders)
      .send({ email: ownerEmail, redirectTo: `${origin}/en/reset-password` })
      .expect(200);
    const unknown = await owner
      .post("/api/auth/request-password-reset")
      .set(sourceHeaders)
      .send({ email: fresh("unknown"), redirectTo: `${origin}/en/reset-password` })
      .expect(200);
    expect(unknown.body).toEqual(known.body);
    const reset = await emailLink(ownerEmail, "reset-password");
    const resetRedirect = await request(app.getHttpServer())
      .get(reset.pathname + reset.search)
      .expect(302);
    const recoveryPage = new URL(resetRedirect.headers.location);
    expect(recoveryPage.origin).toBe(origin);
    expect(recoveryPage.pathname).toBe("/en/reset-password");
    const token = recoveryPage.searchParams.get("token");
    expect(token).toBeTruthy();
    await request(app.getHttpServer())
      .post("/api/auth/reset-password")
      .set(sourceHeaders)
      .send({ token, newPassword: "replacement-password123" })
      .expect(200);
    await request(app.getHttpServer())
      .post("/api/auth/reset-password")
      .set(sourceHeaders)
      .send({ token, newPassword: "another-password123" })
      .expect(400);
    expect(
      (await owner.get("/api/auth/get-session").set(sourceHeaders).expect(200)).body,
    ).toBeNull();
    await owner
      .post("/api/auth/sign-in/email")
      .set(sourceHeaders)
      .send({ email: ownerEmail, password: "replacement-password123" })
      .expect(200);
  });
  it("refuses existing unverified self-hosted cookies centrally, including organization and email mutation routes", async () => {
    const { db } = await import("./db");
    const { schema } = await import("@pubrick/db");
    const legacy = betterAuth({
      database: drizzleAdapter(db, { provider: "pg", schema }),
      baseURL: origin,
      secret: process.env.BETTER_AUTH_SECRET,
      emailAndPassword: { enabled: true },
      session: { cookieCache: { enabled: true } },
      rateLimit: { enabled: false },
    });
    const email = fresh("legacy");
    const signup = await legacy.handler(
      new Request(`${origin}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ email, password, name: "Legacy" }),
      }),
    );
    expect(signup.status).toBe(200);
    const cookie = signup.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    const client = request(app.getHttpServer());
    const legacyHeaders = { ...headers("192.0.2.12"), Cookie: cookie };
    expect(
      (await client.get("/api/auth/get-session").set(legacyHeaders).expect(200)).body,
    ).toBeNull();
    await client.get("/api/brands").set(legacyHeaders).expect(401);
    const organization = await client
      .post("/api/auth/organization/create")
      .set(legacyHeaders)
      .send({ name: "Bypass", slug: `bypass-${Date.now()}` })
      .expect(403);
    expect(organization.body.code).toBe("EMAIL_NOT_VERIFIED");
    const change = await client
      .post("/api/auth/change-email")
      .set(legacyHeaders)
      .send({ newEmail: fresh("takeover") })
      .expect(403);
    expect(change.body.code).toBe("EMAIL_NOT_VERIFIED");
    await client
      .post("/api/auth/send-verification-email")
      .set(legacyHeaders)
      .send({ email, callbackURL: `${origin}/en/verify-email` })
      .expect(200);
    await verify(email);
    const authorized = await client.get("/api/auth/get-session").set(legacyHeaders).expect(200);
    expect(authorized.body.user.emailVerified).toBe(true);
  });
  it("keeps SMTP failures non-enumerating and exposes only safe capability booleans", async () => {
    const logger = vi.spyOn(console, "warn").mockImplementation(() => {});
    await new Promise<void>((resolve) => smtp.close(resolve));
    smtpClosed = true;
    const email = fresh("delivery-failed");
    const client = request.agent(app.getHttpServer());
    const testHeaders = headers("192.0.2.13");
    try {
      await client
        .post("/api/auth/sign-up/email")
        .set(testHeaders)
        .send({ email, password, name: "Failure" })
        .expect(200);
      const known = await client
        .post("/api/auth/request-password-reset")
        .set(testHeaders)
        .send({ email })
        .expect(200);
      const unknown = await client
        .post("/api/auth/request-password-reset")
        .set(testHeaders)
        .send({ email: fresh("unknown") })
        .expect(200);
      expect(known.body).toEqual(unknown.body);
      await (await import("./auth")).authMailer?.drain();
      expect(JSON.stringify(logger.mock.calls)).not.toContain(email);
      const capabilities = await client.get("/api/auth/pubrick-capabilities").expect(200);
      expect(capabilities.body).toEqual({
        requiresEmailVerification: true,
        passwordRecoveryEnabled: true,
      });
    } finally {
      logger.mockRestore();
    }
  });
});
