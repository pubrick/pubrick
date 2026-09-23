import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("watched sources e2e", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  });

  afterAll(async () => {
    await app.close();
  });

  async function orgAgent(): Promise<request.Agent> {
    const agent = request.agent(app.getHttpServer());
    const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `rss${uniq}@example.com`, password: "password1234", name: "U" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Org ${uniq}`, slug: `rss-org-${uniq}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return agent;
  }

  it("scopes feed CRUD and news reads by both organization and brand", async () => {
    const owner = await orgAgent();
    const other = await orgAgent();
    const a = await owner.post("/api/brands").send({ name: "Brand A" }).expect(201);
    const b = await owner.post("/api/brands").send({ name: "Brand B" }).expect(201);
    const source = await owner
      .post("/api/sources")
      .send({
        brandId: a.body.id,
        name: "Journal",
        url: "https://example.com/feed.xml",
      })
      .expect(201);
    expect(source.body).toMatchObject({ brandId: a.body.id, name: "Journal", isActive: true });

    const list = await owner.get(`/api/sources?brandId=${a.body.id}`).expect(200);
    expect(list.body.map((row: { id: string }) => row.id)).toContain(source.body.id);
    expect((await owner.get(`/api/sources?brandId=${b.body.id}`).expect(200)).body).toEqual([]);
    expect((await owner.get(`/api/sources/items?brandId=${a.body.id}`).expect(200)).body).toEqual(
      [],
    );
    await other.get(`/api/sources?brandId=${a.body.id}`).expect(404);
    await other.get(`/api/sources/items?brandId=${a.body.id}`).expect(404);
    await other
      .patch(`/api/sources/${source.body.id}?brandId=${a.body.id}`)
      .send({ isActive: false })
      .expect(404);
    await owner
      .patch(`/api/sources/${source.body.id}?brandId=${b.body.id}`)
      .send({ isActive: false })
      .expect(404);
    await owner.delete(`/api/sources/${source.body.id}?brandId=${b.body.id}`).expect(404);
    await other.delete(`/api/sources/${source.body.id}?brandId=${a.body.id}`).expect(404);

    const refresh = await owner
      .post(`/api/sources/${source.body.id}/refresh?brandId=${a.body.id}`)
      .expect(201);
    expect(refresh.body).toEqual({ queued: false });
    await owner
      .patch(`/api/sources/${source.body.id}?brandId=${a.body.id}`)
      .send({ isActive: false })
      .expect(200);
    await owner.post(`/api/sources/${source.body.id}/refresh?brandId=${a.body.id}`).expect(409);
    await owner.delete(`/api/sources/${source.body.id}?brandId=${a.body.id}`).expect(200);
    expect((await owner.get(`/api/sources?brandId=${a.body.id}`).expect(200)).body).toEqual([]);
  });
});
