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

  async function approvedTopic(client: request.Agent, brandId: string, title: string) {
    const topic = await client
      .post("/api/topics")
      .send({ brandId, title, description: `${title} details` })
      .expect(201);
    await client
      .patch(`/api/topics/${topic.body.id}?brandId=${brandId}`)
      .send({ status: "approved" })
      .expect(200);
    return topic.body.id as string;
  }

  it("creates a bounded topic batch atomically with ordered revision snapshots", async () => {
    const owner = await agent();
    const { brandId, channelId } = await brandChannel(owner);
    const first = await approvedTopic(owner, brandId, "First launch");
    const second = await approvedTopic(owner, brandId, "Second launch");
    const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
    const slots = [
      { topicId: second, expectedTopicRevision: 2, scheduledAt, channelIds: [channelId] },
      { topicId: first, expectedTopicRevision: 2, scheduledAt, channelIds: [channelId] },
    ];
    const created = await owner
      .post("/api/calendar/slots/bulk")
      .send({ brandId, slots })
      .expect(201);
    expect(created.body).toHaveLength(2);
    expect(created.body.map((slot: { topicId: string }) => slot.topicId)).toEqual([second, first]);
    expect(created.body[0]).toMatchObject({
      brandId,
      brief: "Second launch\n\nSecond launch details",
      topicTitle: "Second launch",
      topicDescription: "Second launch details",
      topicRevision: 2,
      channelIds: [channelId],
    });
    const listed = await owner
      .get(
        `/api/calendar/slots?brandId=${brandId}&from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 2 * 86_400_000).toISOString())}`,
      )
      .expect(200);
    expect(listed.body).toHaveLength(2);
  });

  it("validates every bulk row before inserting any slot", async () => {
    const owner = await agent();
    const { brandId, channelId } = await brandChannel(owner);
    const first = await approvedTopic(owner, brandId, "Ready");
    const pending = await owner
      .post("/api/topics")
      .send({ brandId, title: "Needs approval" })
      .expect(201);
    const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
    const valid = {
      topicId: first,
      expectedTopicRevision: 2,
      scheduledAt,
      channelIds: [channelId],
    };
    const unapproved = {
      topicId: pending.body.id,
      expectedTopicRevision: 1,
      scheduledAt,
      channelIds: [channelId],
    };
    expect(
      (
        await owner
          .post("/api/calendar/slots/bulk")
          .send({ brandId, slots: [valid, unapproved] })
          .expect(409)
      ).body.code,
    ).toBe("topic_not_approved");
    expect(
      (
        await owner
          .post("/api/calendar/slots/bulk")
          .send({ brandId, slots: [valid, { ...unapproved, topicId: first }] })
          .expect(400)
      ).body.code,
    ).toBe("invalid_request");
    expect(
      (await owner.post("/api/calendar/slots/bulk").send({ brandId, slots: [] }).expect(400)).body
        .code,
    ).toBe("invalid_request");
    expect(
      (
        await owner
          .post("/api/calendar/slots/bulk")
          .send({
            brandId,
            slots: Array.from({ length: 21 }, (_, index) => ({
              ...valid,
              topicId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            })),
          })
          .expect(400)
      ).body.code,
    ).toBe("invalid_request");
    expect(
      (
        await owner
          .post("/api/calendar/slots/bulk")
          .send({
            brandId,
            slots: [valid, { ...unapproved, scheduledAt: new Date(0).toISOString() }],
          })
          .expect(400)
      ).body.code,
    ).toBe("calendar_time_in_past");
    const foreign = await agent();
    const { brandId: foreignBrandId, channelId: foreignChannel } = await brandChannel(foreign);
    expect(
      (
        await owner
          .post("/api/calendar/slots/bulk")
          .send({ brandId, slots: [valid, { ...unapproved, channelIds: [foreignChannel] }] })
          .expect(404)
      ).body.code,
    ).toBe("channels_not_in_brand");
    const foreignTopicId = await approvedTopic(foreign, foreignBrandId, "Another organization");
    expect(
      (
        await owner
          .post("/api/calendar/slots/bulk")
          .send({ brandId, slots: [valid, { ...unapproved, topicId: foreignTopicId }] })
          .expect(404)
      ).body.code,
    ).toBe("topic_not_found");
    const listed = await owner
      .get(
        `/api/calendar/slots?brandId=${brandId}&from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 2 * 86_400_000).toISOString())}`,
      )
      .expect(200);
    expect(listed.body).toEqual([]);
  });

  it("rejects an approved topic edited after preview without creating any batch slots", async () => {
    const owner = await agent();
    const { brandId, channelId } = await brandChannel(owner);
    const first = await approvedTopic(owner, brandId, "Original title");
    const second = await approvedTopic(owner, brandId, "Other topic");
    const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
    const slots = [first, second].map((topicId) => ({
      topicId,
      expectedTopicRevision: 2,
      scheduledAt,
      channelIds: [channelId],
    }));
    expect(
      (
        await owner
          .post("/api/calendar/slots/bulk")
          .send({ brandId, slots: [{ ...slots[0], expectedTopicRevision: undefined }] })
          .expect(400)
      ).body.code,
    ).toBe("invalid_request");

    await owner
      .patch(`/api/topics/${first}?brandId=${brandId}`)
      .send({ title: "Revised title", description: "Revised source details" })
      .expect(200);
    const revised = await owner
      .patch(`/api/topics/${first}?brandId=${brandId}`)
      .send({ status: "approved" })
      .expect(200);
    expect(revised.body.revision).toBe(4);
    expect(
      (await owner.post("/api/calendar/slots/bulk").send({ brandId, slots }).expect(409)).body.code,
    ).toBe("calendar_topic_changed");
    const range = `/api/calendar/slots?brandId=${brandId}&from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 2 * 86_400_000).toISOString())}`;
    expect((await owner.get(range).expect(200)).body).toEqual([]);

    const created = await owner
      .post("/api/calendar/slots/bulk")
      .send({ brandId, slots: [{ ...slots[0], expectedTopicRevision: 4 }, slots[1]] })
      .expect(201);
    expect(created.body).toHaveLength(2);
    expect(created.body[0]).toMatchObject({
      topicTitle: "Revised title",
      topicDescription: "Revised source details",
      topicRevision: 4,
    });
  });

  it("rejects already planned topics and serializes competing bulk requests", async () => {
    const owner = await agent();
    const { brandId, channelId } = await brandChannel(owner);
    const topicId = await approvedTopic(owner, brandId, "One plan");
    const otherTopicId = await approvedTopic(owner, brandId, "Second plan");
    const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
    const body = {
      brandId,
      slots: [
        {
          topicId,
          expectedTopicRevision: 2,
          scheduledAt,
          channelIds: [channelId],
        },
        {
          topicId: otherTopicId,
          expectedTopicRevision: 2,
          scheduledAt,
          channelIds: [channelId],
        },
      ],
    };
    const responses = await Promise.all([
      owner.post("/api/calendar/slots/bulk").send(body),
      owner.post("/api/calendar/slots/bulk").send({ ...body, slots: [...body.slots].reverse() }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.status === 409)?.body.code).toBe(
      "calendar_topic_already_planned",
    );
    const listed = await owner
      .get(
        `/api/calendar/slots?brandId=${brandId}&from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 2 * 86_400_000).toISOString())}`,
      )
      .expect(200);
    expect(listed.body).toHaveLength(2);
    expect(
      (
        await owner
          .post("/api/calendar/slots/bulk")
          .send({
            ...body,
            slots: [
              body.slots[0],
              {
                topicId: await approvedTopic(owner, brandId, "Fresh plan"),
                expectedTopicRevision: 2,
                scheduledAt,
                channelIds: [channelId],
              },
            ],
          })
          .expect(409)
      ).body.code,
    ).toBe("calendar_topic_already_planned");
    const afterConflict = await owner
      .get(
        `/api/calendar/slots?brandId=${brandId}&from=${encodeURIComponent(new Date().toISOString())}&to=${encodeURIComponent(new Date(Date.now() + 2 * 86_400_000).toISOString())}`,
      )
      .expect(200);
    expect(afterConflict.body).toHaveLength(2);
  });

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

  it("stores cover opt-in only with a Google key and lets an editor turn it off", async () => {
    const owner = await agent();
    const { brandId, channelId } = await brandChannel(owner);
    const payload = {
      brandId,
      scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
      brief: "Launch story",
      channelIds: [channelId],
      generateCover: true,
    };
    const refused = await owner.post("/api/calendar/slots").send(payload).expect(400);
    expect(refused.body.code).toBe("cover_requires_google_key");
    await owner
      .put("/api/ai-credentials")
      .send({ provider: "google", apiKey: "test-only-google-key-0123456789" })
      .expect(200);
    const mastodon = await owner
      .post("/api/channels")
      .send({
        brandId,
        platform: "mastodon",
        name: "Mastodon",
        credentials: { instanceUrl: "https://mastodon.example", accessToken: "test-token" },
      })
      .expect(201);
    const unsupported = await owner
      .post("/api/calendar/slots")
      .send({ ...payload, channelIds: [mastodon.body.id] })
      .expect(400);
    expect(unsupported.body.code).toBe("content_media_unsupported");
    const created = await owner.post("/api/calendar/slots").send(payload).expect(201);
    expect(created.body.generateCover).toBe(true);
    const slotId = created.body.id as string;
    await owner.delete("/api/ai-credentials/google").expect(200);
    const unchanged = await owner
      .patch(`/api/calendar/slots/${slotId}?brandId=${brandId}`)
      .send({ brief: "Updated launch", generateCover: true })
      .expect(400);
    expect(unchanged.body.code).toBe("cover_requires_google_key");
    const disabled = await owner
      .patch(`/api/calendar/slots/${slotId}?brandId=${brandId}`)
      .send({ generateCover: false })
      .expect(200);
    expect(disabled.body.generateCover).toBe(false);
  });

  it("snapshots only an approved topic in the same organization and brand and protects its deletion", async () => {
    const owner = await agent();
    const outsider = await agent();
    const { brandId, channelId } = await brandChannel(owner);
    const otherBrand = await owner.post("/api/brands").send({ name: "Another brand" }).expect(201);
    const foreign = await outsider
      .post("/api/topics")
      .send({
        brandId: (await brandChannel(outsider)).brandId,
        title: "Foreign topic",
      })
      .expect(201);
    const topic = await owner
      .post("/api/topics")
      .send({
        brandId,
        title: "Product launch",
        description: "Facts approved by the editor",
        sourceUrl: "https://example.com/launch",
      })
      .expect(201);
    const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
    const body = { brandId, scheduledAt, channelIds: [channelId], topicId: topic.body.id };
    expect((await owner.post("/api/calendar/slots").send(body).expect(409)).body.code).toBe(
      "topic_not_approved",
    );
    await owner
      .patch(`/api/topics/${topic.body.id}?brandId=${brandId}`)
      .send({ status: "approved" })
      .expect(200);
    expect(
      (
        await owner
          .post("/api/calendar/slots")
          .send({ ...body, topicId: foreign.body.id })
          .expect(404)
      ).body.code,
    ).toBe("topic_not_found");
    expect(
      (
        await owner
          .post("/api/calendar/slots")
          .send({ ...body, brandId: otherBrand.body.id })
          .expect(404)
      ).body.code,
    ).toBe("channels_not_in_brand");
    const otherChannel = await owner
      .post("/api/channels")
      .send({
        brandId: otherBrand.body.id,
        platform: "telegram",
        name: "Other brand channel",
        credentials: { botToken: "123:abc", chatId: "-1001234567890" },
      })
      .expect(201);
    expect(
      (
        await owner
          .post("/api/calendar/slots")
          .send({ ...body, brandId: otherBrand.body.id, channelIds: [otherChannel.body.id] })
          .expect(404)
      ).body.code,
    ).toBe("topic_not_found");
    const slot = await owner.post("/api/calendar/slots").send(body).expect(201);
    expect(slot.body).toMatchObject({
      topicId: topic.body.id,
      topicTitle: "Product launch",
      topicDescription: "Facts approved by the editor",
      topicSourceUrl: "https://example.com/launch",
      brief: "Product launch\n\nFacts approved by the editor",
    });
    await owner
      .patch(`/api/topics/${topic.body.id}?brandId=${brandId}`)
      .send({ status: "approved" })
      .expect(200);
    const refreshed = await owner
      .patch(`/api/calendar/slots/${slot.body.id}?brandId=${brandId}`)
      .send({ topicId: topic.body.id })
      .expect(200);
    expect(refreshed.body.topicRevision).toBeGreaterThan(slot.body.topicRevision);
    expect(
      (await owner.delete(`/api/topics/${topic.body.id}?brandId=${brandId}`).expect(409)).body.code,
    ).toBe("topic_has_calendar_slots");
    expect(
      (
        await owner
          .patch(`/api/calendar/slots/${slot.body.id}?brandId=${brandId}`)
          .send({ brief: "Silent replacement" })
          .expect(409)
      ).body.code,
    ).toBe("calendar_topic_linked");
    const unlinked = await owner
      .patch(`/api/calendar/slots/${slot.body.id}?brandId=${brandId}`)
      .send({ topicId: null, brief: "Editorial override" })
      .expect(200);
    expect(unlinked.body).toMatchObject({
      topicId: null,
      topicTitle: null,
      brief: "Editorial override",
    });
    await owner.delete(`/api/topics/${topic.body.id}?brandId=${brandId}`).expect(200);
  });

  it("still allows deleting a brand with a linked topic and planned slot", async () => {
    const owner = await agent();
    const { brandId, channelId } = await brandChannel(owner);
    const topic = await owner
      .post("/api/topics")
      .send({ brandId, title: "Brand retirement", description: "Approved facts" })
      .expect(201);
    await owner
      .patch(`/api/topics/${topic.body.id}?brandId=${brandId}`)
      .send({ status: "approved" })
      .expect(200);
    await owner
      .post("/api/calendar/slots")
      .send({
        brandId,
        topicId: topic.body.id,
        scheduledAt: new Date(Date.now() + 86_400_000).toISOString(),
        channelIds: [channelId],
      })
      .expect(201);
    await owner.delete(`/api/brands/${brandId}`).expect(200);
  });
});
