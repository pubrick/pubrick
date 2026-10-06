import { randomUUID } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import {
  decryptJson,
  encryptJson,
  postingQueuePreviewDtoSchema,
  postingScheduleDtoSchema,
} from "@pubrick/shared";
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
function firstRow<T>(rows: readonly T[]): T {
  const value = rows[0];
  if (value === undefined) throw new Error("Fixture must have at least one row");
  return value;
}
describe.skipIf(!url)("posting queue transaction acceptance", () => {
  let app: INestApplication;
  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    const { AppModule } = await import("../app.module");
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
  });
  afterAll(async () => {
    await app.close();
  });

  async function fixture() {
    const agent = request.agent(app.getHttpServer());
    const id = randomUUID();
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `${id}@example.com`, password: "Parity-test-password-123!", name: "Editor" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: "Posting team", slug: `posting-${id}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    const brand = await agent.post("/api/brands").send({ name: "Creator" }).expect(201);
    const channelIds: string[] = [];
    for (const [name, time] of [
      ["Morning", "09:00"],
      ["Evening", "18:00"],
    ]) {
      const channel = await agent
        .post("/api/channels")
        .send({
          brandId: brand.body.id,
          platform: "telegram",
          name,
          credentials: { botToken: "123:disposable", chatId: "-1001234567890" },
        })
        .expect(201);
      channelIds.push(channel.body.id);
      const result = await agent
        .put(`/api/channels/${channel.body.id}/posting-schedule`)
        .send({
          expectedRevision: 0,
          timezone: "UTC",
          slots: Array.from({ length: 7 }, (_, index) => ({ weekday: index + 1, localTime: time })),
        })
        .expect(200);
      expect(postingScheduleDtoSchema.parse(result.body).revision).toBe(1);
    }
    return { agent, orgId: org.body.id as string, brandId: brand.body.id as string, channelIds };
  }
  async function content(f: Awaited<ReturnType<typeof fixture>>, ids = f.channelIds) {
    const item = await f.agent
      .post("/api/content")
      .send({
        brandId: f.brandId,
        body: "Reviewed saved content.",
        title: "A useful post",
        channelIds: ids,
      })
      .expect(201);
    return (await f.agent.get(`/api/content/${item.body.id}`).expect(200)).body;
  }
  async function preview(
    f: Awaited<ReturnType<typeof fixture>>,
    item: { id: string; postingReviewFingerprint: string },
  ) {
    const result = await f.agent
      .post(`/api/content/${item.id}/posting-queue/preview`)
      .send({ reviewFingerprint: item.postingReviewFingerprint })
      .expect(200);
    return postingQueuePreviewDtoSchema.parse(result.body);
  }
  async function jobCount(orgId: string) {
    const { db } = await import("../db");
    const result = await db.execute(
      sql`select count(*)::int as n from pgboss.job where name = 'publish' and data->>'orgId' = ${orgId}`,
    );
    return firstRow(result.rows).n;
  }

  it("previews exact different channel times without scheduling, then commits rows and jobs once", async () => {
    const f = await fixture();
    const item = await content(f);
    const plan = await preview(f, item);
    expect(new Set(plan.destinations.map((row) => row.scheduledAt)).size).toBe(2);
    expect(await jobCount(f.orgId)).toBe(0);
    const result = await f.agent
      .post(`/api/content/${item.id}/approve`)
      .send({ queuePreviewToken: plan.token })
      .expect(200);
    expect(result.body.status).toBe("approved");
    for (const row of plan.destinations)
      expect(
        result.body.adaptations.find((a: { id: string }) => a.id === row.adaptationId),
      ).toMatchObject({ status: "scheduled", scheduledAt: row.scheduledAt });
    expect(await jobCount(f.orgId)).toBe(2);
    await f.agent
      .post(`/api/content/${item.id}/approve`)
      .send({ queuePreviewToken: plan.token })
      .expect(409);
    expect(await jobCount(f.orgId)).toBe(2);
  });
  it("refuses stale visible content before preview and stale saved content after preview", async () => {
    const f = await fixture();
    const item = await content(f);
    const plan = await preview(f, item);
    await f.agent
      .patch(`/api/content/${item.id}`)
      .send({ body: "A different saved body." })
      .expect(200);
    const stale = await f.agent
      .post(`/api/content/${item.id}/posting-queue/preview`)
      .send({ reviewFingerprint: item.postingReviewFingerprint })
      .expect(409);
    expect(stale.body.code).toBe("posting_preview_changed");
    const refused = await f.agent
      .post(`/api/content/${item.id}/approve`)
      .send({ queuePreviewToken: plan.token })
      .expect(409);
    expect(refused.body.code).toBe("posting_preview_changed");
    expect(await jobCount(f.orgId)).toBe(0);
  });

  it.each(["immediate", "timed", "relative"])(
    "fences %s approval against unseen saved edits",
    async (mode) => {
      const f = await fixture();
      for (const change of ["body", "adaptation", "images"]) {
        const item = await content(f, [firstRow(f.channelIds)]);
        if (change === "body")
          await f.agent
            .patch(`/api/content/${item.id}`)
            .send({ body: "Changed after review" })
            .expect(200);
        else if (change === "adaptation")
          await f.agent
            .patch(`/api/content/${item.id}/adaptations/${item.adaptations[0].id}`)
            .send({ body: "Unseen channel edit" })
            .expect(200);
        else {
          const images = (await f.agent.get(`/api/content/${item.id}/images`).expect(200)).body;
          await f.agent
            .put(`/api/content/${item.id}/images`)
            .send({ expectedRevision: images.revision, images: [] })
            .expect(200);
        }
        const result = await f.agent
          .post(`/api/content/${item.id}/approve`)
          .send({
            expectedReviewFingerprint: item.postingReviewFingerprint,
            ...(mode === "timed"
              ? { scheduledAt: new Date(Date.now() + 86_400_000).toISOString() }
              : mode === "relative"
                ? { delayMinutes: 30 }
                : {}),
          })
          .expect(409);
        expect(result.body.code).toBe("posting_preview_changed");
        expect(await jobCount(f.orgId)).toBe(0);
      }
    },
  );
  it("refuses schedule ABA changes without moving approved jobs", async () => {
    const f = await fixture();
    const item = await content(f);
    const plan = await preview(f, item);
    const path = `/api/channels/${firstRow(f.channelIds)}/posting-schedule`;
    const original = (await f.agent.get(path).expect(200)).body;
    await f.agent.put(path).send({ expectedRevision: 1, timezone: "UTC", slots: [] }).expect(200);
    await f.agent
      .put(path)
      .send({ expectedRevision: 2, timezone: "UTC", slots: original.slots })
      .expect(200);
    const refused = await f.agent
      .post(`/api/content/${item.id}/approve`)
      .send({ queuePreviewToken: plan.token })
      .expect(409);
    expect(refused.body.code).toBe("posting_preview_changed");
    expect(await jobCount(f.orgId)).toBe(0);
  });
  it("serializes competing previews and legacy timed approval against the same slot", async () => {
    const f = await fixture();
    const first = await content(f, [firstRow(f.channelIds)]);
    const second = await content(f, [firstRow(f.channelIds)]);
    const [a, b] = await Promise.all([preview(f, first), preview(f, second)]);
    expect(firstRow(a.destinations).scheduledAt).toBe(firstRow(b.destinations).scheduledAt);
    const outcomes = await Promise.all([
      f.agent.post(`/api/content/${first.id}/approve`).send({ queuePreviewToken: a.token }),
      f.agent
        .post(`/api/content/${second.id}/approve`)
        .send({ scheduledAt: firstRow(b.destinations).scheduledAt }),
    ]);
    expect(outcomes.map((row) => row.status).sort()).toEqual([200, 409]);
    expect(outcomes.find((row) => row.status === 409)?.body.code).toBe("posting_slot_occupied");
    expect(await jobCount(f.orgId)).toBe(1);
    const stillDraft = firstRow(outcomes).status === 409 ? first : second;
    const fresh = await preview(f, stillDraft);
    expect(firstRow(fresh.destinations).scheduledAt).not.toBe(firstRow(a.destinations).scheduledAt);
  });
  it("binds previews/settings to the workspace and enforces expiry", async () => {
    const f = await fixture();
    const other = await fixture();
    const item = await content(f);
    const plan = await preview(f, item);
    await other.agent.get(`/api/channels/${firstRow(f.channelIds)}/posting-schedule`).expect(404);
    await other.agent
      .post(`/api/content/${item.id}/posting-queue/preview`)
      .send({ reviewFingerprint: item.postingReviewFingerprint })
      .expect(404);
    const key = process.env.APP_ENCRYPTION_KEY as string;
    const expired = decryptJson<Record<string, unknown>>(plan.token, key);
    expired.expiresAt = 0;
    const result = await f.agent
      .post(`/api/content/${item.id}/approve`)
      .send({ queuePreviewToken: encryptJson(expired, key) })
      .expect(409);
    expect(result.body.code).toBe("posting_preview_changed");
    expect(await jobCount(f.orgId)).toBe(0);
  });
  it("pages upcoming deliveries by scheduled time instead of creation order", async () => {
    const f = await fixture();
    const later = await content(f, [firstRow(f.channelIds)]);
    const sooner = await content(f, [firstRow(f.channelIds)]);
    const now = Date.now();
    await f.agent
      .post(`/api/content/${later.id}/approve`)
      .send({ scheduledAt: new Date(now + 3 * 86_400_000).toISOString() })
      .expect(200);
    await f.agent
      .post(`/api/content/${sooner.id}/approve`)
      .send({ scheduledAt: new Date(now + 2 * 86_400_000).toISOString() })
      .expect(200);
    const page = await f.agent
      .get(`/api/brands/${f.brandId}/publications?filter=scheduled&limit=1`)
      .expect(200);
    expect(page.body.rows[0].contentItemId).toBe(sooner.id);
    expect(page.body.nextCursor).toMatch(/^pq1\./);
    const next = await f.agent
      .get(
        `/api/brands/${f.brandId}/publications?filter=scheduled&limit=1&cursor=${encodeURIComponent(page.body.nextCursor)}`,
      )
      .expect(200);
    expect(next.body.rows[0].contentItemId).toBe(later.id);
    expect(next.body.nextCursor).toBeNull();
  });
});
