import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { mediaAssetDtoSchema } from "@pubrick/shared";
import sharp from "sharp";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("media library e2e", () => {
  let app: INestApplication;
  let mediaDir: string;

  beforeAll(async () => {
    mediaDir = await mkdtemp(path.join(tmpdir(), "pubrick-media-test-"));
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
    await app.close();
    await rm(mediaDir, { recursive: true, force: true });
  });

  async function agent() {
    const user = request.agent(app.getHttpServer());
    const uniq = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await user
      .post("/api/auth/sign-up/email")
      .send({ email: `media-${uniq}@example.com`, password: "password1234", name: "U" })
      .expect(200);
    const org = await user
      .post("/api/auth/organization/create")
      .send({ name: `Media ${uniq}`, slug: `media-${uniq}` })
      .expect(200);
    await user
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return user;
  }

  it("normalizes an uploaded image, strips metadata, and keeps both metadata and file tenant scoped", async () => {
    const owner = await agent();
    const stranger = await agent();
    const brand = await owner.post("/api/brands").send({ name: "Brand" }).expect(201);
    const png = await sharp({ create: { width: 3, height: 2, channels: 3, background: "#ff0000" } })
      .png()
      .withMetadata({ exif: { IFD0: { Copyright: "private metadata" } } })
      .toBuffer();
    const upload = await owner
      .post(`/api/media?brandId=${brand.body.id}`)
      .attach("file", png, { filename: "cover.png", contentType: "image/png" })
      .expect(201);
    expect(upload.body).toMatchObject({
      brandId: brand.body.id,
      mimeType: "image/jpeg",
      width: 3,
      height: 2,
    });
    expect(mediaAssetDtoSchema.safeParse(upload.body).success).toBe(true);
    const file = await owner.get(`/api/media/${upload.body.id}/file`).expect(200);
    expect(file.headers["content-type"]).toMatch(/image\/jpeg/);
    expect(file.headers["x-content-type-options"]).toBe("nosniff");
    const saved = await readFile(path.join(mediaDir, `${upload.body.id}.jpg`));
    const metadata = await sharp(saved).metadata();
    expect(metadata.format).toBe("jpeg");
    expect(metadata.exif).toBeUndefined();
    expect(saved.includes(Buffer.from("private metadata"))).toBe(false);
    const listed = await owner.get(`/api/media?brandId=${brand.body.id}`).expect(200);
    expect(listed.body.map((row: { id: string }) => row.id)).toContain(upload.body.id);
    await stranger.get(`/api/media?brandId=${brand.body.id}`).expect(404);
    await stranger.get(`/api/media/${upload.body.id}/file`).expect(404);
    await stranger.delete(`/api/media/${upload.body.id}`).expect(404);
    await owner.delete(`/api/media/${upload.body.id}`).expect(204);
    await owner.get(`/api/media/${upload.body.id}/file`).expect(404);
  });

  it("refuses a disguised payload before writing an asset", async () => {
    const owner = await agent();
    const brand = await owner.post("/api/brands").send({ name: "Brand" }).expect(201);
    await owner
      .post(`/api/media?brandId=${brand.body.id}`)
      .attach("file", Buffer.from("<script>alert(1)</script>"), {
        filename: "fake.png",
        contentType: "image/png",
      })
      .expect(400);
    expect((await owner.get(`/api/media?brandId=${brand.body.id}`).expect(200)).body).toEqual([]);
  });

  it("removes an uploaded file when its brand is deleted", async () => {
    const owner = await agent();
    const brand = await owner.post("/api/brands").send({ name: "Temporary brand" }).expect(201);
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#00ff00" } })
      .png()
      .toBuffer();
    const uploaded = await owner
      .post(`/api/media?brandId=${brand.body.id}`)
      .attach("file", png, { filename: "green.png", contentType: "image/png" })
      .expect(201);
    const file = path.join(mediaDir, `${uploaded.body.id}.jpg`);
    expect((await readFile(file)).length).toBeGreaterThan(0);
    await owner.delete(`/api/brands/${brand.body.id}`).expect(200);
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes a brand whose post still holds a cover", async () => {
    const owner = await agent();
    const brand = await owner.post("/api/brands").send({ name: "Covered brand" }).expect(201);
    const channel = await owner
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Main",
        credentials: { botToken: "123:abc", chatId: "-1001234567890" },
      })
      .expect(201);
    const post = await owner
      .post("/api/content")
      .send({ brandId: brand.body.id, body: "Hello", channelIds: [channel.body.id] })
      .expect(201);
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#00ff00" } })
      .png()
      .toBuffer();
    const uploaded = await owner
      .post(`/api/media?brandId=${brand.body.id}`)
      .attach("file", png, { filename: "green.png", contentType: "image/png" })
      .expect(201);
    await owner
      .patch(`/api/media/posts/${post.body.id}/cover`)
      .send({ mediaId: uploaded.body.id })
      .expect(200);
    const file = path.join(mediaDir, `${uploaded.body.id}.jpg`);
    await owner.delete(`/api/brands/${brand.body.id}`).expect(200);
    await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("attaches only a same-brand image to an editable Telegram post and protects it from deletion", async () => {
    const owner = await agent();
    const brand = await owner.post("/api/brands").send({ name: "Brand" }).expect(201);
    const another = await owner.post("/api/brands").send({ name: "Other" }).expect(201);
    const channel = await owner
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Main",
        credentials: { botToken: "123:abc", chatId: "-1001234567890" },
      })
      .expect(201);
    const item = await owner
      .post("/api/content")
      .send({ brandId: brand.body.id, body: "Hello", channelIds: [channel.body.id] })
      .expect(201);
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#0000ff" } })
      .png()
      .toBuffer();
    const foreign = await owner
      .post(`/api/media?brandId=${another.body.id}`)
      .attach("file", png, { filename: "foreign.png", contentType: "image/png" })
      .expect(201);
    await owner
      .patch(`/api/media/posts/${item.body.id}/cover`)
      .send({ mediaId: foreign.body.id })
      .expect(404);
    const image = await owner
      .post(`/api/media?brandId=${brand.body.id}`)
      .attach("file", png, { filename: "cover.png", contentType: "image/png" })
      .expect(201);
    await owner
      .patch(`/api/media/posts/${item.body.id}/cover`)
      .send({ mediaId: image.body.id })
      .expect(200);
    expect((await owner.get(`/api/content/${item.body.id}`).expect(200)).body.coverMediaId).toBe(
      image.body.id,
    );
    await owner
      .patch(`/api/content/${item.body.id}`)
      .send({ body: "x".repeat(1025) })
      .expect(200);
    await owner.post(`/api/content/${item.body.id}/approve`).send({}).expect(409);
    await owner.patch(`/api/content/${item.body.id}`).send({ body: "Hello" }).expect(200);
    await owner.delete(`/api/media/${image.body.id}`).expect(409);

    const manual = await owner
      .post("/api/channels")
      .send({ brandId: brand.body.id, platform: "vc_ru", name: "Manual" })
      .expect(201);
    const manualPost = await owner
      .post("/api/content")
      .send({ brandId: brand.body.id, body: "Hello", channelIds: [manual.body.id] })
      .expect(201);
    await owner
      .patch(`/api/media/posts/${manualPost.body.id}/cover`)
      .send({ mediaId: image.body.id })
      .expect(409);
    await owner.patch(`/api/media/posts/${item.body.id}/cover`).send({ mediaId: null }).expect(200);
    await owner.delete(`/api/media/${image.body.id}`).expect(204);
  });
});
