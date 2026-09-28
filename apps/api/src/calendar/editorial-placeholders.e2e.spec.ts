import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("editorial reservations API", () => {
  let app: INestApplication;
  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
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
    await app?.close();
  });

  async function agent() {
    const client = request.agent(app.getHttpServer());
    const stamp = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await client
      .post("/api/auth/sign-up/email")
      .send({ email: `editorial${stamp}@example.com`, password: "password1234", name: "Editor" })
      .expect(200);
    const org = await client
      .post("/api/auth/organization/create")
      .send({ name: `Editorial ${stamp}`, slug: `editorial-${stamp}` })
      .expect(200);
    await client
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return client;
  }

  async function brand(client: request.Agent) {
    const created = await client.post("/api/brands").send({ name: "Calendar brand" }).expect(201);
    return created.body.id as string;
  }

  it("keeps blank dated reservations scoped and separate from generation jobs", async () => {
    const owner = await agent();
    const outsider = await agent();
    const brandId = await brand(owner);
    const otherBrandId = await brand(owner);
    const route = "/api/calendar/editorial-placeholders";
    const body = {
      brandId,
      date: "2026-09-30",
      platform: "vk",
      contentType: "social_post",
      timeOfDay: "09:45",
      notes: "Product announcement",
    };
    await owner
      .post(route)
      .send({ ...body, timeOfDay: "25:00" })
      .expect(400);
    await owner
      .post(route)
      .send({ ...body, date: "2026-09-31" })
      .expect(400);
    await outsider.post(route).send(body).expect(404);
    const runsBefore = (await owner.get("/api/runs").expect(200)).body;
    const created = await owner.post(route).send(body).expect(201);
    const id = created.body.id as string;
    expect(created.body).toMatchObject(body);
    expect(created.body.date).toBe("2026-09-30");
    const range = `brandId=${brandId}&from=2026-09-01&to=2026-10-01`;
    expect((await owner.get(`${route}?${range}`).expect(200)).body).toMatchObject([{ id }]);
    expect(
      (await owner.get(`${route}?brandId=${brandId}&from=2026-10-01&to=2026-11-01`).expect(200))
        .body,
    ).toEqual([]);
    expect(
      (
        await owner
          .get(`${route}?brandId=${otherBrandId}&from=2026-09-01&to=2026-10-01`)
          .expect(200)
      ).body,
    ).toEqual([]);
    await outsider.get(`${route}?${range}`).expect(404);
    await owner.get(`${route}?brandId=${brandId}&from=2026-09-01&to=2027-01-01`).expect(400);
    const scheduledRange = `brandId=${brandId}&from=${encodeURIComponent("2026-09-01T00:00:00.000Z")}&to=${encodeURIComponent("2026-10-01T00:00:00.000Z")}`;
    expect((await owner.get(`/api/calendar/slots?${scheduledRange}`).expect(200)).body).toEqual([]);
    expect((await owner.get("/api/runs").expect(200)).body).toEqual(runsBefore);

    await owner
      .patch(`${route}/${id}?brandId=${otherBrandId}`)
      .send({ notes: "Wrong" })
      .expect(404);
    await outsider.patch(`${route}/${id}?brandId=${brandId}`).send({ notes: "Wrong" }).expect(404);
    await owner.patch(`${route}/${id}?brandId=${brandId}`).send({}).expect(400);
    const updated = await owner
      .patch(`${route}/${id}?brandId=${brandId}`)
      .send({ platform: null, notes: null, date: "2026-10-02" })
      .expect(200);
    expect(updated.body).toMatchObject({ id, date: "2026-10-02", platform: null, notes: null });
    await owner.delete(`${route}/${id}?brandId=${otherBrandId}`).expect(404);
    await outsider.delete(`${route}/${id}?brandId=${brandId}`).expect(404);
    await owner.delete(`${route}/${id}?brandId=${brandId}`).expect(200);
    expect(
      (await owner.get(`${route}?brandId=${brandId}&from=2026-10-01&to=2026-11-01`).expect(200))
        .body,
    ).toEqual([]);
  });
});
