import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schema } from "@pubrick/db";
import { contentDetailDtoSchema } from "@pubrick/shared";
import { asc, eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("saved-body compare-and-swap", () => {
  let app: INestApplication;
  let db: typeof import("../db").db;
  let agent: request.Agent;
  let brandId: string;
  let channelId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    const [{ AppModule }, database] = await Promise.all([import("../app.module"), import("../db")]);
    db = database.db;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
    agent = request.agent(app.getHttpServer());
    const id = randomUUID();
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `body-cas-${id}@example.com`, password: "password1234", name: "Editor" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: "Body CAS team", slug: `body-cas-${id}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    const brand = await agent.post("/api/brands").send({ name: "Body CAS brand" }).expect(201);
    brandId = brand.body.id;
    const channel = await agent
      .post("/api/channels")
      .send({
        brandId,
        platform: "telegram",
        name: "Main",
        credentials: { botToken: "123:disposable", chatId: "-1001234567890" },
      })
      .expect(201);
    channelId = channel.body.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  async function content() {
    const created = await agent
      .post("/api/content")
      .send({ brandId, title: "Original title", body: "Saved master.", channelIds: [channelId] })
      .expect(201);
    return contentDetailDtoSchema.parse(
      (await agent.get(`/api/content/${created.body.id}`).expect(200)).body,
    );
  }

  async function savedState(itemId: string) {
    const [item] = await db
      .select({
        title: schema.contentItems.title,
        body: schema.contentItems.body,
        richBody: schema.contentItems.richBody,
        revision: schema.contentItems.bodyRevision,
        status: schema.contentItems.status,
      })
      .from(schema.contentItems)
      .where(eq(schema.contentItems.id, itemId));
    const adaptations = await db
      .select({
        body: schema.adaptations.body,
        hashtags: schema.adaptations.hashtags,
        cta: schema.adaptations.cta,
        status: schema.adaptations.status,
        scheduledAt: schema.adaptations.scheduledAt,
        attemptCount: schema.adaptations.attemptCount,
      })
      .from(schema.adaptations)
      .where(eq(schema.adaptations.contentItemId, itemId))
      .orderBy(asc(schema.adaptations.id));
    const versions = await db
      .select({ id: schema.contentVersions.id, body: schema.contentVersions.body })
      .from(schema.contentVersions)
      .where(eq(schema.contentVersions.contentItemId, itemId))
      .orderBy(asc(schema.contentVersions.id));
    return { item, adaptations, versions };
  }

  function adaptationId(item: Awaited<ReturnType<typeof content>>) {
    const adaptation = item.adaptations[0];
    if (!adaptation) throw new Error("Fixture must have an adaptation");
    return adaptation.id;
  }

  it("refuses a plain master replacement with only the expected text stale", async () => {
    const item = await content();
    const before = await savedState(item.id);
    const refusal = await agent
      .patch(`/api/content/${item.id}`)
      .send({
        title: "Must not be written",
        body: "My replacement.",
        expectedBody: "An older master.",
        expectedBodyRevision: item.bodyRevision,
      })
      .expect(409);
    expect(refusal.body.code).toBe("version_changed");
    expect(refusal.body.bodyRevision).toBe(item.bodyRevision);
    expect(await savedState(item.id)).toEqual(before);
  });

  it("refuses a plain replacement after formatting changed without changing the text", async () => {
    const item = await content();
    const path = `/api/content/${item.id}`;
    await agent
      .patch(path)
      .send({
        body: item.body,
        richBody: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: item.body, marks: [{ type: "bold" }] }],
            },
          ],
        },
        expectedBody: item.body,
        expectedBodyRevision: item.bodyRevision,
      })
      .expect(200);
    const before = await savedState(item.id);
    expect(before.item?.revision).toBe((item.bodyRevision ?? 0) + 1);
    const refusal = await agent
      .patch(path)
      .send({
        body: "My replacement.",
        expectedBody: item.body,
        expectedBodyRevision: item.bodyRevision,
      })
      .expect(409);
    expect(refusal.body.code).toBe("version_changed");
    expect(await savedState(item.id)).toEqual(before);
  });

  it("accepts a current plain snapshot and preserves expectation-free legacy writes", async () => {
    const item = await content();
    const path = `/api/content/${item.id}`;
    const saved = await agent
      .patch(path)
      .send({
        body: "Current replacement.",
        expectedBody: item.body,
        expectedBodyRevision: item.bodyRevision,
      })
      .expect(200);
    expect(saved.body.body).toBe("Current replacement.");
    expect(saved.body.bodyRevision).toBe((item.bodyRevision ?? 0) + 1);
    expect(
      (await agent.patch(path).send({ body: "Legacy replacement." }).expect(200)).body.body,
    ).toBe("Legacy replacement.");
  });

  it("compares channel expectations against the raw stored text with its managed suffix", async () => {
    const item = await content();
    const path = `/api/content/${item.id}/adaptations/${adaptationId(item)}`;
    const first = await agent
      .patch(path)
      .send({ body: "Channel copy.", hashtags: ["news"], expectedHashtags: [] })
      .expect(200);
    expect(first.body.body).toBe("Channel copy.\n\n#news");
    const before = await savedState(item.id);
    const refusal = await agent
      .patch(path)
      .send({ body: "Replacement.", expectedBody: "Channel copy." })
      .expect(409);
    expect(refusal.body.code).toBe("version_changed");
    expect(await savedState(item.id)).toEqual(before);
    const saved = await agent
      .patch(path)
      .send({ body: "Replacement.", expectedBody: first.body.body })
      .expect(200);
    expect(saved.body.body).toBe("Replacement.\n\n#news");
  });

  it("refuses clearing an override when an inherited baseline is stale", async () => {
    const item = await content();
    const path = `/api/content/${item.id}/adaptations/${adaptationId(item)}`;
    await agent.patch(path).send({ body: "New teammate copy." }).expect(200);
    const before = await savedState(item.id);
    const refusal = await agent.patch(path).send({ body: null, expectedBody: null }).expect(409);
    expect(refusal.body.code).toBe("version_changed");
    expect(await savedState(item.id)).toEqual(before);
  });

  it("accepts an inherited snapshot, then explicitly clears its current override", async () => {
    const item = await content();
    const path = `/api/content/${item.id}/adaptations/${adaptationId(item)}`;
    const saved = await agent
      .patch(path)
      .send({ body: "My channel copy.", expectedBody: null })
      .expect(200);
    expect(saved.body.body).toBe("My channel copy.");
    const cleared = await agent
      .patch(path)
      .send({ body: null, expectedBody: saved.body.body })
      .expect(200);
    expect(cleared.body.body).toBeNull();
    expect(cleared.body.hashtags).toEqual([]);
    expect(cleared.body.cta).toBeNull();
  });

  it.each(["master", "channel"] as const)(
    "admits only one concurrent %s replacement from the same snapshot",
    async (level) => {
      const item = await content();
      const path =
        level === "master"
          ? `/api/content/${item.id}`
          : `/api/content/${item.id}/adaptations/${adaptationId(item)}`;
      const baseline =
        level === "master"
          ? { expectedBody: item.body, expectedBodyRevision: item.bodyRevision }
          : { expectedBody: null };
      const before = await savedState(item.id);
      const responses = await Promise.all([
        agent.patch(path).send({ body: "First editor.", ...baseline }),
        agent.patch(path).send({ body: "Second editor.", ...baseline }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const winner = responses.find((response) => response.status === 200);
      expect(responses.find((response) => response.status === 409)?.body.code).toBe(
        "version_changed",
      );
      const after = await savedState(item.id);
      expect(after.versions).toHaveLength(before.versions.length + 1);
      expect(level === "master" ? after.item?.body : after.adaptations[0]?.body).toBe(
        winner?.body.body,
      );
      expect(after.adaptations[0]?.scheduledAt).toBeNull();
      expect(after.adaptations[0]?.attemptCount).toBe(0);
    },
  );
});
