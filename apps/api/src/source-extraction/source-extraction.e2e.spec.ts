import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SourceExtractionService } from "./source-extraction.service";

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)("source extraction e2e", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
    vi.spyOn(app.get(SourceExtractionService), "extract").mockResolvedValue({
      title: "Guide",
      material: "Guide\n\nA readable article.",
      truncated: false,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("requires an active organization and validates the public URL before fetching", async () => {
    await request(app.getHttpServer())
      .post("/api/source-extraction")
      .send({ url: "https://example.com/article" })
      .expect(401);

    const agent = request.agent(app.getHttpServer());
    const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `extract${uniq}@example.com`, password: "password1234", name: "U" })
      .expect(200);
    await agent
      .post("/api/source-extraction")
      .send({ url: "https://example.com/article" })
      .expect(403);

    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${uniq}`, slug: `extract-org-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);

    for (const url of ["ftp://example.com/file", "https://user:pass@example.com/article"]) {
      await agent.post("/api/source-extraction").send({ url }).expect(400);
    }
    expect(app.get(SourceExtractionService).extract).not.toHaveBeenCalled();

    const answer = await agent
      .post("/api/source-extraction")
      .send({ url: "https://example.com/article" })
      .expect(200);
    expect(answer.body).toEqual({
      title: "Guide",
      material: "Guide\n\nA readable article.",
      truncated: false,
    });
    expect(app.get(SourceExtractionService).extract).toHaveBeenCalledOnce();
  });
});
