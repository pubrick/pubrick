import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb } from "@pubrick/db";
import { openAuthMail } from "@pubrick/mail";
import { AUTH_MAIL_QUEUE } from "@pubrick/shared";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { simpleParser } from "mailparser";
import { PgBoss } from "pg-boss";
import { SMTPServer } from "smtp-server";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
// Test-only integration crosses application source; deployable apps remain independent.
import type { AuthMailService } from "../../worker/src/auth-mail/auth-mail.service";

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("hosted ownership against real auth storage and local SMTP", () => {
  let app: INestApplication;
  let boss: PgBoss;
  let consumer: AuthMailService;
  let external: ReturnType<typeof createDb>;
  const committedKinds = new Set<string>();
  let smtp: SMTPServer;
  let smtpClosed = false;
  const messages: Array<{ to: string; body: string }> = [];
  const retryAttempts = new Map<string, string[]>();
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
        const recipient = session.envelope.rcptTo[0]?.address;
        if (!recipient) {
          stream.resume();
          callback(new Error("Missing fixture recipient"));
          return;
        }
        let body = "";
        stream.on("data", (chunk) => {
          body += chunk.toString();
        });
        stream.on("end", () => {
          if (recipient.startsWith("retry-check-")) {
            const attempts = retryAttempts.get(recipient) ?? [];
            attempts.push(body);
            retryAttempts.set(recipient, attempts);
            if (attempts.length < 4) {
              callback(
                Object.assign(new Error("Synthetic transient retry"), { responseCode: 451 }),
              );
              return;
            }
          }
          messages.push({ to: recipient, body });
          callback();
        });
      },
    });
    await new Promise<void>((resolve) => smtp.listen(0, "127.0.0.1", resolve));
    const address = smtp.server.address();
    if (!address || typeof address === "string") throw new Error("Missing local SMTP port");
    Object.assign(process.env, {
      DATABASE_URL: databaseUrl,
      NODE_ENV: "test",
      BILLING_DRIVER: "fixture",
      BILLING_ACCOUNT_ID: "fixture_hosted_http",
      BILLING_MAX_OWNED_WORKSPACES: "2",
      BILLING_MAX_CREATES_PER_DAY: "3",
      BILLING_CATALOG_JSON: JSON.stringify([
        {
          id: "operator_fixture",
          version: "v1",
          priceId: "price_fixture_hosted",
          limits: { seats: 4, brands: 2, channels: 2, mediaBytes: 1048576, concurrentJobs: 2 },
        },
      ]),
      BILLING_FIXTURE_PRICES_JSON: JSON.stringify([
        {
          priceId: "price_fixture_hosted",
          productId: "prod_fixture_hosted",
          active: true,
          currency: "usd",
          unitAmount: 1,
          interval: "month",
          intervalCount: 1,
        },
      ]),
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
    // Separate pool proves SDK reset/invitation writes are committed before callbacks.
    external = createDb(databaseUrl as string);
    const outbox = await import("./auth-mail-outbox.repository");
    const enqueue = outbox.enqueueAuthMail;
    vi.spyOn(outbox, "enqueueAuthMail").mockImplementation(async (queue, data) => {
      await enqueue(queue, data, external.db);
      committedKinds.add(data.kind);
    });
    const { AppModule } = await import("./app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
    const { AuthMailService } = await import("../../worker/src/auth-mail/auth-mail.service");
    const { AuthMailRepository } = await import("../../worker/src/auth-mail/auth-mail.repository");
    consumer = new AuthMailService(new AuthMailRepository());
    boss = new PgBoss(databaseUrl as string);
    await boss.start();
    await consumer.register(boss);
  });
  afterAll(async () => {
    await boss?.stop({ graceful: true });
    consumer?.onModuleDestroy();
    await app?.close();
    await external?.pool.end();
    await (await import("../../worker/src/db")).pool.end();
    vi.restoreAllMocks();
    if (smtp && !smtpClosed) await new Promise<void>((resolve) => smtp.close(resolve));
  });
  async function emailLink(email: string, part: string) {
    await (await import("./auth")).authMailer?.drain();
    await vi.waitFor(
      () =>
        expect(messages.some((entry) => entry.to === email && entry.body.includes(part))).toBe(
          true,
        ),
      { timeout: 10000, interval: 25 },
    );
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
  async function seedEntitlement(orgId: string) {
    // Native test settlement only: no trial, no fixture checkout URL, no production payment claim.
    const { schema } = await import("@pubrick/db");
    const identity = {
      provider: "fixture",
      environment: "sandbox",
      accountId: "fixture_hosted_http",
    } as const;
    const { and, eq } = await import("drizzle-orm");
    const [plan] = await external.db
      .select({ id: schema.billingPlanVersions.id })
      .from(schema.billingPlanVersions)
      .where(
        and(
          eq(schema.billingPlanVersions.provider, identity.provider),
          eq(schema.billingPlanVersions.environment, identity.environment),
          eq(schema.billingPlanVersions.accountId, identity.accountId),
          eq(schema.billingPlanVersions.priceId, "price_fixture_hosted"),
        ),
      );
    expect(plan).toBeDefined();
    if (!plan) throw new Error("Runtime did not initialize operator test plan");
    const planVersionId = plan.id;
    const priceId = "price_fixture_hosted";
    const subscriptionId = `sub_${randomUUID()}`;
    const accessUntil = new Date(Date.now() + 86400000);
    await external.db.insert(schema.billingSubscriptions).values({
      orgId,
      ...identity,
      customerId: `cus_${randomUUID()}`,
      subscriptionId,
      status: "active",
      priceId,
      planVersionId,
      periodStart: new Date(Date.now() - 1000),
      periodEnd: accessUntil,
      cancelAtPeriodEnd: false,
    });
    await external.db
      .insert(schema.organizationBillingState)
      .values({ orgId, subscriptionId, planVersionId, access: true, accessUntil });
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
      .post("/api/hosted-admission/create")
      .set(sourceHeaders)
      .send({ name: "Hosted identity", slug: `hosted-${Date.now()}` })
      .expect(200);
    // Custom cookie-authenticated writers reject cross-site, missing-origin and non-JSON requests.
    const rejectedSlug = `csrf-${randomUUID()}`;
    await owner
      .post("/api/hosted-admission/create")
      .send({ name: "CSRF", slug: rejectedSlug })
      .expect(403);
    await owner
      .post("/api/hosted-admission/create")
      .set({ ...sourceHeaders, "Sec-Fetch-Site": "cross-site" })
      .send({ name: "CSRF", slug: rejectedSlug })
      .expect(403);
    await owner
      .post("/api/hosted-admission/create")
      .set(sourceHeaders)
      .set("Content-Type", "text/plain")
      .send(JSON.stringify({ name: "CSRF", slug: rejectedSlug }))
      .expect(403);
    const orgId = organization.body.id;
    const { schema } = await import("@pubrick/db");
    const { eq } = await import("drizzle-orm");
    expect(
      await external.db
        .select()
        .from(schema.organizationBillingState)
        .where(eq(schema.organizationBillingState.orgId, orgId)),
    ).toHaveLength(0);
    // All actual SDK writers stay closed, even for the verified workspace owner.
    for (const path of [
      "create",
      "invite-member",
      "accept-invitation",
      "reject-invitation",
      "cancel-invitation",
      "remove-member",
      "update-member-role",
      "leave",
      "delete",
    ]) {
      const blocked = await owner
        .post(`/api/auth/organization/${path}`)
        .set(sourceHeaders)
        .send({
          name: "Bypass",
          slug: `bypass-${randomUUID()}`,
          organizationId: orgId,
          email: fresh("bypass"),
          role: "member",
          invitationId: "missing",
          memberId: "missing",
          teamId: "missing",
        })
        .expect(403);
      expect(blocked.body.code).toBe("HOSTED_ORGANIZATION_MUTATION_REQUIRED");
    }
    // Better Auth exposes addMember only server-side; no public add-member endpoint exists.
    await owner
      .post("/api/auth/organization/add-member")
      .set(sourceHeaders)
      .send({ organizationId: orgId })
      .expect(404);
    const session = await owner.get("/api/auth/get-session").set(sourceHeaders).expect(200);
    const { auth } = await import("./auth");
    await expect(
      auth.api.addMember({
        body: { organizationId: orgId, userId: session.body.user.id, role: "member" },
      }),
    ).rejects.toMatchObject({ body: { code: "HOSTED_ORGANIZATION_MUTATION_REQUIRED" } });
    await owner.get("/api/auth/organization/list").set(sourceHeaders).expect(200);
    await owner
      .post("/api/auth/organization/set-active")
      .set(sourceHeaders)
      .send({ organizationId: orgId })
      .expect(200);
    await owner
      .post("/api/auth/organization/update")
      .set(sourceHeaders)
      .send({ organizationId: orgId, data: { name: "Hosted metadata" } })
      .expect(200);
    await owner
      .get(`/api/auth/organization/get-full-organization?organizationId=${orgId}`)
      .set(sourceHeaders)
      .expect(200);
    const memberEmail = fresh("member");
    // No entitlement exists at creation: invitation growth must fail until the operator test seed.
    await owner
      .post("/api/hosted-admission/invite")
      .set(sourceHeaders)
      .send({ orgId, email: memberEmail, role: "author", locale: "en" })
      .expect(402);
    await seedEntitlement(orgId);
    const invitation = await owner
      .post("/api/hosted-admission/invite")
      .set(sourceHeaders)
      .send({ orgId, email: memberEmail, role: "author", locale: "en" })
      .expect(200);
    await (await import("./auth")).authMailer?.drain();
    await vi.waitFor(
      () =>
        expect(
          messages.some((entry) => entry.to === memberEmail && entry.body.includes("onboarding")),
        ).toBe(true),
      { timeout: 10000, interval: 25 },
    );
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
      .post("/api/hosted-admission/accept")
      .set(memberHeaders)
      .send({ orgId, invitationId: invitation.body.id })
      .expect(401);
    await verify(memberEmail);
    await member
      .post("/api/auth/sign-in/email")
      .set(memberHeaders)
      .send({ email: memberEmail, password })
      .expect(200);
    await member
      .post("/api/hosted-admission/accept")
      .set(memberHeaders)
      .send({ orgId, invitationId: invitation.body.id })
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
    expect([...committedKinds].sort()).toEqual(["reset", "verify"]);
    // Custom invitation and encrypted job commit atomically in the domain transaction.
    const persistedInvite = await external.db
      .select()
      .from(schema.invitation)
      .where(eq(schema.invitation.id, invitation.body.id));
    expect(persistedInvite[0]?.status).toBe("accepted");
    const jobs = await external.pool.query("select data from pgboss.job where name=$1", [
      AUTH_MAIL_QUEUE,
    ]);
    expect(JSON.stringify(jobs.rows)).not.toContain(ownerEmail);
    expect(JSON.stringify(jobs.rows)).not.toContain("token=");
    const resetRedirect = await request(app.getHttpServer())
      .get(reset.pathname + reset.search)
      .expect(302);
    const location = resetRedirect.headers.location;
    if (!location) throw new Error("Missing recovery redirect");
    const recoveryPage = new URL(location);
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
  it("survives consumer restart with encrypted storage and stable message identity", async () => {
    await boss.stop({ graceful: true });
    consumer.onModuleDestroy();
    const email = fresh("durable-restart");
    await request(app.getHttpServer())
      .post("/api/auth/sign-up/email")
      .set(headers("192.0.2.24"))
      .send({ email, password, name: "Durable" })
      .expect(200);
    expect(messages.some((message) => message.to === email)).toBe(false);
    const queued = await external.pool.query(
      "select data from pgboss.job where name=$1 and state='created'",
      [AUTH_MAIL_QUEUE],
    );
    expect(queued.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(queued.rows)).not.toContain(email);
    const { AuthMailService } = await import("../../worker/src/auth-mail/auth-mail.service");
    const { AuthMailRepository } = await import("../../worker/src/auth-mail/auth-mail.repository");
    consumer = new AuthMailService(new AuthMailRepository());
    boss = new PgBoss(databaseUrl as string);
    await boss.start();
    await consumer.register(boss);
    await emailLink(email, "verify-email");
    const parsed = await simpleParser(messages.find((message) => message.to === email)?.body ?? "");
    expect(parsed.messageId).toMatch(/^<pubrick-auth\.[0-9a-f-]+@localhost>$/);
  });
  it("retries transient SMTP through pg-boss within four attempts using a stable Message-ID", async () => {
    const email = fresh("retry-check");
    await boss.updateQueue(AUTH_MAIL_QUEUE, { retryDelay: 1, retryBackoff: false });
    try {
      await request(app.getHttpServer())
        .post("/api/auth/sign-up/email")
        .set(headers("192.0.2.25"))
        .send({ email, password, name: "Retry" })
        .expect(200);
      await emailLink(email, "verify-email");
      const bodies = retryAttempts.get(email) ?? [];
      expect(bodies).toHaveLength(4);
      const ids = await Promise.all(
        bodies.map(async (body) => (await simpleParser(body)).messageId),
      );
      expect(new Set(ids).size).toBe(1);
      const { env } = await import("./env");
      await vi.waitFor(
        async () => {
          const jobs = await external.pool.query(
            "select data,state,retry_count from pgboss.job where name=$1",
            [AUTH_MAIL_QUEUE],
          );
          const value = jobs.rows.find(
            (row) => openAuthMail(row.data, env.APP_ENCRYPTION_KEY).recipient === email,
          );
          expect(value?.state).toBe("completed");
          expect(value?.retry_count).toBe(3);
        },
        { timeout: 10000, interval: 25 },
      );
    } finally {
      await boss.updateQueue(AUTH_MAIL_QUEUE, { retryDelay: 30, retryBackoff: true });
    }
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
        deploymentMode: "hosted",
        requiresEmailVerification: true,
        passwordRecoveryEnabled: true,
        billingEnabled: true,
        billingTestMode: true,
      });
    } finally {
      logger.mockRestore();
    }
  });
});
