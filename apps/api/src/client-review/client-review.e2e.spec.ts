import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { schema } from "@pubrick/db";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("client approval links", () => {
  let app: INestApplication;
  let mediaDir: string;

  beforeAll(async () => {
    mediaDir = await mkdtemp(path.join(tmpdir(), "pubrick-client-review-media-"));
    process.env.MEDIA_STORAGE_DIR = mediaDir;
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
    await rm(mediaDir, { recursive: true, force: true });
  });

  async function orgAgent() {
    const agent = request.agent(app.getHttpServer());
    const suffix = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await agent
      .post("/api/auth/sign-up/email")
      .send({ email: `review${suffix}@example.com`, password: "password1234", name: "Editor" })
      .expect(200);
    const org = await agent
      .post("/api/auth/organization/create")
      .send({ name: `Review ${suffix}`, slug: `review-${suffix}` })
      .expect(200);
    await agent
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return agent;
  }

  async function draft(agent: request.Agent) {
    const brand = await agent.post("/api/brands").send({ name: "Example" }).expect(201);
    const channel = await agent
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Updates",
        credentials: { botToken: "123:abc", chatId: "-1001234567890" },
      })
      .expect(201);
    const item = await agent
      .post("/api/content")
      .send({
        brandId: brand.body.id,
        title: "Launch",
        body: "Saved body",
        channelIds: [channel.body.id],
      })
      .expect(201);
    return { itemId: item.body.id as string, brandId: brand.body.id as string };
  }

  it("requires the guest decision before internal approval and keeps it final", async () => {
    const owner = await orgAgent();
    const { itemId } = await draft(owner);
    const created = await owner
      .post(`/api/content/${itemId}/client-review-link`)
      .send({})
      .expect(201);
    const token = created.body.token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.body.status).toBe("pending");
    const guest = request(app.getHttpServer());
    const preview = await guest.get(`/api/client-review/${token}`).expect(200);
    expect(preview.headers["cache-control"]).toContain("no-store");
    expect(preview.headers["referrer-policy"]).toBe("no-referrer");
    expect(preview.body.preview).toMatchObject({
      title: "Launch",
      body: "Saved body",
      channels: [{ platform: "telegram", name: "Updates", body: "Saved body" }],
    });
    const blocked = await owner.post(`/api/content/${itemId}/approve`).send({}).expect(409);
    expect(blocked.body.code).toBe("client_review_required");
    await guest
      .post(`/api/client-review/${token}/verdict`)
      .send({ verdict: "changes_requested", comment: "Correct the date" })
      .expect(200);
    await guest
      .post(`/api/client-review/${token}/verdict`)
      .send({ verdict: "approved" })
      .expect(409);
    const status = await owner.get(`/api/content/${itemId}/client-review-link`).expect(200);
    expect(status.body).toMatchObject({
      status: "changes_requested",
      comment: "Correct the date",
    });
    await owner.post(`/api/content/${itemId}/approve`).send({}).expect(409);

    const replacement = await owner
      .post(`/api/content/${itemId}/client-review-link`)
      .send({ expiresInHours: 24 })
      .expect(201);
    const closed = await guest.get(`/api/client-review/${token}`).expect(410);
    expect(closed.headers["cache-control"]).toContain("no-store");
    expect(closed.headers["referrer-policy"]).toBe("no-referrer");
    await guest
      .post(`/api/client-review/${replacement.body.token}/verdict`)
      .send({ verdict: "approved" })
      .expect(200);
    const approved = await owner.get(`/api/content/${itemId}/client-review-link`).expect(200);
    expect(approved.body.status).toBe("approved");
    await owner.post(`/api/content/${itemId}/approve`).send({}).expect(200);
    await owner.post(`/api/content/${itemId}/client-review-link`).send({}).expect(409);
  });

  it("closes a changed preview and keeps status scoped to the workspace", async () => {
    const owner = await orgAgent();
    const outsider = await orgAgent();
    const { itemId } = await draft(owner);
    const created = await owner
      .post(`/api/content/${itemId}/client-review-link`)
      .send({})
      .expect(201);
    await outsider.get(`/api/content/${itemId}/client-review-link`).expect(404);
    await owner.patch(`/api/content/${itemId}`).send({ body: "Changed after link" }).expect(200);
    await request(app.getHttpServer()).get(`/api/client-review/${created.body.token}`).expect(410);
    const status = await owner.get(`/api/content/${itemId}/client-review-link`).expect(200);
    expect(status.body.status).toBe("stale");
    await owner.post(`/api/content/${itemId}/approve`).send({}).expect(409);
    await owner.delete(`/api/content/${itemId}/client-review-link`).expect(204);
    await owner.post(`/api/content/${itemId}/approve`).send({}).expect(200);
  });

  it("keeps an approved verdict after expiry but blocks an unanswered expired link", async () => {
    const owner = await orgAgent();
    const { itemId } = await draft(owner);
    const created = await owner
      .post(`/api/content/${itemId}/client-review-link`)
      .send({})
      .expect(201);
    const { db } = await import("../db");
    await db
      .update(schema.clientReviewLinks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.clientReviewLinks.contentItemId, itemId));
    await request(app.getHttpServer()).get(`/api/client-review/${created.body.token}`).expect(410);
    const expired = await owner.get(`/api/content/${itemId}/client-review-link`).expect(200);
    expect(expired.body.status).toBe("expired");
    await owner.post(`/api/content/${itemId}/approve`).send({}).expect(409);

    const replacement = await owner
      .post(`/api/content/${itemId}/client-review-link`)
      .send({})
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/client-review/${replacement.body.token}/verdict`)
      .send({ verdict: "approved" })
      .expect(200);
    await db
      .update(schema.clientReviewLinks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.clientReviewLinks.contentItemId, itemId));
    const approved = await owner.get(`/api/content/${itemId}/client-review-link`).expect(200);
    expect(approved.body.status).toBe("approved");
    await owner.post(`/api/content/${itemId}/approve`).send({}).expect(200);
  });

  it("serves only the attached JPEG cover through the capability", async () => {
    const owner = await orgAgent();
    const { itemId, brandId } = await draft(owner);
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "#ffcc00" },
    })
      .png()
      .toBuffer();
    const uploaded = await owner
      .post(`/api/media?brandId=${brandId}`)
      .attach("file", png, { filename: "cover.png", contentType: "image/png" })
      .expect(201);
    await owner
      .patch(`/api/media/posts/${itemId}/cover`)
      .send({ mediaId: uploaded.body.id })
      .expect(200);
    const created = await owner
      .post(`/api/content/${itemId}/client-review-link`)
      .send({})
      .expect(201);
    const guest = request(app.getHttpServer());
    const preview = await guest.get(`/api/client-review/${created.body.token}`).expect(200);
    expect(preview.body.preview.coverUrl).toBe(`/api/client-review/${created.body.token}/cover`);
    const cover = await guest.get(preview.body.preview.coverUrl).expect(200);
    expect(cover.headers["content-type"]).toMatch(/^image\/jpeg/);
    expect(cover.headers["cache-control"]).toContain("no-store");
    expect(cover.headers["referrer-policy"]).toBe("no-referrer");
    expect(cover.body.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    await owner.patch(`/api/content/${itemId}`).send({ body: "Changed" }).expect(200);
    const closed = await guest.get(preview.body.preview.coverUrl).expect(410);
    expect(closed.headers["cache-control"]).toContain("no-store");
  });

  it("streams a bounded video through the live capability and makes replacement stale", async () => {
    const owner = await orgAgent();
    const { itemId, brandId } = await draft(owner);
    const bytes = await readFile(path.resolve(process.cwd(), "src/media/fixtures/tiny-h264.mp4"));
    const uploaded = await owner
      .post(`/api/media?brandId=${brandId}`)
      .attach("file", bytes, { filename: "review.mp4", contentType: "video/mp4" })
      .expect(201);
    await owner
      .patch(`/api/media/posts/${itemId}/video`)
      .send({ mediaId: uploaded.body.id })
      .expect(200);
    const created = await owner
      .post(`/api/content/${itemId}/client-review-link`)
      .send({})
      .expect(201);
    const guest = request(app.getHttpServer());
    const url = `/api/client-review/${created.body.token}/video`;
    const preview = await guest.get(`/api/client-review/${created.body.token}`).expect(200);
    expect(preview.body.preview.videoUrl).toBe(url);
    expect(preview.body.preview.coverUrl).toBeNull();
    const range = await guest.get(url).set("Range", "bytes=0-15").expect(206);
    expect(range.headers["content-type"]).toMatch(/^video\/mp4/);
    expect(range.headers["content-range"]).toBe(`bytes 0-15/${bytes.length}`);
    expect(range.headers["cache-control"]).toContain("no-store");
    expect(range.headers["referrer-policy"]).toBe("no-referrer");
    await owner.patch(`/api/media/posts/${itemId}/video`).send({ mediaId: null }).expect(200);
    await guest.get(url).set("Range", "bytes=16-31").expect(410);
    expect(
      (await owner.get(`/api/content/${itemId}/client-review-link`).expect(200)).body.status,
    ).toBe("stale");
  });
});
