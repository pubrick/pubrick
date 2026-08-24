import { Controller, Get, type INestApplication, UseGuards } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("org scoping e2e", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const { runMigrations } = await import("@pubrick/db");
    await runMigrations(url as string);

    const { AppModule } = await import("../app.module");
    const { ActiveOrgGuard } = await import("./active-org.guard");
    const { OrgId } = await import("./org-id.decorator");

    @Controller("org-probe")
    @UseGuards(ActiveOrgGuard)
    class OrgProbeController {
      @Get()
      probe(@OrgId() orgId: string): { orgId: string } {
        return { orgId };
      }
    }

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [OrgProbeController],
    }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  async function signUpAgent() {
    const agent = request.agent(app.getHttpServer());
    const email = `u${Date.now()}${Math.floor(Math.random() * 1e6)}@example.com`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email, password: "password1234", name: "U" })
      .expect(200);
    return agent;
  }

  it("403s when no active organization is set", async () => {
    const agent = await signUpAgent();
    await agent.get("/api/org-probe").expect(403);
  });

  it("passes org id through after create + set-active", async () => {
    const agent = await signUpAgent();
    const slug = `acme-${Date.now()}`;
    const created = await agent
      .post("/api/auth/organization/create")
      .send({ name: "Acme", slug })
      .expect(200);
    const orgId = created.body.id as string;
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: orgId })
      .expect(200);
    const probe = await agent.get("/api/org-probe").expect(200);
    expect(probe.body.orgId).toBe(orgId);
  });

  it("401s without a session", async () => {
    await request(app.getHttpServer()).get("/api/org-probe").expect(401);
  });
});
