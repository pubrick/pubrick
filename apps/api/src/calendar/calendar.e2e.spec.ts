import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("calendar API", () => {
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
      .send({
        email: `calendar${stamp}@example.com`,
        password: "password1234",
        name: "Calendar User",
      })
      .expect(200);
    const org = await client
      .post("/api/auth/organization/create")
      .send({ name: `Calendar ${stamp}`, slug: `calendar-${stamp}` })
      .expect(200);
    await client
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return client;
  }
  async function brandChannel(client: request.Agent) {
    const brand = await client.post("/api/brands").send({ name: "Calendar brand" }).expect(201);
    const channel = await client
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Main",
        credentials: { botToken: "123:abc", chatId: "-1001234567890" },
      })
      .expect(201);
    return { brandId: brand.body.id as string, channelId: channel.body.id as string };
  }

  it("scopes create, list, update and removal to the organization and brand", async () => {
    const owner = await agent();
    const outsider = await agent();
    const { brandId, channelId } = await brandChannel(owner);
    const otherBrand = await owner.post("/api/brands").send({ name: "Other brand" }).expect(201);
    const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
    const created = await owner
      .post("/api/calendar/slots")
      .send({
        brandId,
        scheduledAt,
        brief: "Opening day",
        channelIds: [channelId],
        notes: "Draft only",
      })
      .expect(201);
    const slotId = created.body.id as string;
    const range = `from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 3 * 86_400_000).toISOString())}`;
    const own = await owner.get(`/api/calendar/slots?brandId=${brandId}&${range}`).expect(200);
    expect(own.body.map((slot: { id: string }) => slot.id)).toContain(slotId);
    expect(
      (await owner.get(`/api/calendar/slots?brandId=${otherBrand.body.id}&${range}`).expect(200))
        .body,
    ).toEqual([]);
    expect(
      (await outsider.get(`/api/calendar/slots?brandId=${brandId}&${range}`).expect(200)).body,
    ).toEqual([]);
    await outsider
      .patch(`/api/calendar/slots/${slotId}?brandId=${brandId}`)
      .send({ brief: "Stolen" })
      .expect(404);
    await owner
      .patch(`/api/calendar/slots/${slotId}?brandId=${otherBrand.body.id}`)
      .send({ brief: "Wrong" })
      .expect(404);
    await owner
      .patch(`/api/calendar/slots/${slotId}?brandId=${brandId}`)
      .send({ brief: "Revised opening" })
      .expect(200);
    await outsider.delete(`/api/calendar/slots/${slotId}?brandId=${brandId}`).expect(404);
    await owner.delete(`/api/calendar/slots/${slotId}?brandId=${brandId}`).expect(200);
  });

  it("rejects foreign channels and past dates before writing a slot", async () => {
    const owner = await agent();
    const { brandId } = await brandChannel(owner);
    const foreign = await agent();
    const { channelId: foreignChannel } = await brandChannel(foreign);
    const wrongChannel = await owner
      .post("/api/calendar/slots")
      .send({
        brandId,
        scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
        brief: "Topic",
        channelIds: [foreignChannel],
      })
      .expect(404);
    expect(wrongChannel.body.code).toBe("channels_not_in_brand");
    const past = await owner
      .post("/api/calendar/slots")
      .send({
        brandId,
        scheduledAt: new Date(Date.now() - 60_000).toISOString(),
        brief: "Topic",
        channelIds: [foreignChannel],
      })
      .expect(400);
    expect(past.body.code).toBe("calendar_time_in_past");
  });
});
