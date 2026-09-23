import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("memorable dates API", () => {
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
      .send({ email: `dates${stamp}@example.com`, password: "password1234", name: "Date User" })
      .expect(200);
    const org = await client
      .post("/api/auth/organization/create")
      .send({ name: `Dates ${stamp}`, slug: `dates-${stamp}` })
      .expect(200);
    await client
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return client;
  }
  async function brand(client: request.Agent) {
    const response = await client.post("/api/brands").send({ name: "Date brand" }).expect(201);
    return response.body.id as string;
  }

  it("validates real month-days and scopes every operation to organization and brand", async () => {
    const owner = await agent();
    const outsider = await agent();
    const brandId = await brand(owner);
    const otherBrandId = await brand(owner);
    const data = {
      brandId,
      monthDay: "02-29",
      title: "Leap day",
      leadDays: 14,
      suggestedContentTypes: ["social_post"],
      isActive: true,
    };
    await owner
      .post("/api/calendar/memorable-dates")
      .send({ ...data, monthDay: "02-30" })
      .expect(400);
    await outsider.post("/api/calendar/memorable-dates").send(data).expect(404);
    const created = await owner.post("/api/calendar/memorable-dates").send(data).expect(201);
    const id = created.body.id as string;
    expect(created.body).toMatchObject({ monthDay: "02-29", title: "Leap day", leadDays: 14 });
    const own = await owner.get(`/api/calendar/memorable-dates?brandId=${brandId}`).expect(200);
    expect(own.body).toMatchObject({ timezone: "UTC", dates: [{ id, monthDay: "02-29" }] });
    await owner
      .get(`/api/calendar/memorable-dates?brandId=${otherBrandId}`)
      .expect(200)
      .then((response) => expect(response.body.dates).toEqual([]));
    await outsider.get(`/api/calendar/memorable-dates?brandId=${brandId}`).expect(404);
    await owner
      .patch(`/api/calendar/memorable-dates/${id}?brandId=${otherBrandId}`)
      .send({ title: "Wrong" })
      .expect(404);
    await outsider
      .patch(`/api/calendar/memorable-dates/${id}?brandId=${brandId}`)
      .send({ title: "Wrong" })
      .expect(404);
    await owner
      .patch(`/api/calendar/memorable-dates/${id}?brandId=${brandId}`)
      .send({ title: "Updated", isActive: false })
      .expect(200);
    await owner.delete(`/api/calendar/memorable-dates/${id}?brandId=${otherBrandId}`).expect(404);
    await outsider.delete(`/api/calendar/memorable-dates/${id}?brandId=${brandId}`).expect(404);
    await owner.delete(`/api/calendar/memorable-dates/${id}?brandId=${brandId}`).expect(200);
    expect(
      (await owner.get(`/api/calendar/memorable-dates?brandId=${brandId}`).expect(200)).body.dates,
    ).toEqual([]);
  });
});
