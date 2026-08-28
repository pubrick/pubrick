import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("auth e2e", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const { runMigrations } = await import("@pubrick/db");
    await runMigrations(url as string);
    const { AppModule } = await import("./app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("signs up and reads the session back via cookie", async () => {
    const agent = request.agent(app.getHttpServer());
    const email = `u${Date.now()}@example.com`;
    const signUp = await agent
      .post("/api/auth/sign-up/email")
      .send({ email, password: "password1234", name: "Test User" });
    expect(signUp.status).toBe(200);

    const session = await agent.get("/api/auth/get-session");
    expect(session.status).toBe(200);
    expect(session.body.user.email).toBe(email);
  });

  it("health stays anonymous", async () => {
    await request(app.getHttpServer()).get("/api/health").expect(200);
  });

  // A returning member's fresh session must already carry their organization: without
  // it the web app reads activeOrganizationId === null and sends someone who already
  // has a workspace to /onboarding to create a second one.
  it("a returning member's new sign-in session carries their organization", async () => {
    const email = `u${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
    const password = "password1234";

    const first = request.agent(app.getHttpServer());
    await first.post("/api/auth/sign-up/email").send({ email, password, name: "Returning" });
    const created = await first
      .post("/api/auth/organization/create")
      .send({ name: "Returning Co", slug: `returning-${Date.now()}` })
      .expect(200);
    const orgId = created.body.id as string;

    // A brand new cookie jar: this is the LATER sign-in, not the sign-up session.
    const second = request.agent(app.getHttpServer());
    await second.post("/api/auth/sign-in/email").send({ email, password }).expect(200);

    const session = await second.get("/api/auth/get-session").expect(200);
    expect(session.body.session.activeOrganizationId).toBe(orgId);
  });

  it("a member of several organizations gets the earliest one they joined", async () => {
    const email = `u${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
    const password = "password1234";

    const first = request.agent(app.getHttpServer());
    await first.post("/api/auth/sign-up/email").send({ email, password, name: "Multi" });
    const earliest = await first
      .post("/api/auth/organization/create")
      .send({ name: "First Co", slug: `first-${Date.now()}` })
      .expect(200);
    await first
      .post("/api/auth/organization/create")
      .send({ name: "Second Co", slug: `second-${Date.now()}` })
      .expect(200);

    const second = request.agent(app.getHttpServer());
    await second.post("/api/auth/sign-in/email").send({ email, password }).expect(200);

    const session = await second.get("/api/auth/get-session").expect(200);
    expect(session.body.session.activeOrganizationId).toBe(earliest.body.id);
  });

  it("a user with no organization still gets a session with no active org", async () => {
    const email = `u${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
    const password = "password1234";

    const first = request.agent(app.getHttpServer());
    await first
      .post("/api/auth/sign-up/email")
      .send({ email, password, name: "Orgless" })
      .expect(200);

    const second = request.agent(app.getHttpServer());
    await second.post("/api/auth/sign-in/email").send({ email, password }).expect(200);

    const session = await second.get("/api/auth/get-session").expect(200);
    expect(session.body.session.activeOrganizationId ?? null).toBeNull();
  });
});
