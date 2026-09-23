import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import { mediaAssetDtoSchema } from "@pubrick/shared";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiImageCaller } from "./gemini-image.caller";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("media library e2e", () => {
  let app: INestApplication;
  let mediaDir: string;
  let direct: ReturnType<typeof createDb>;
  let generatedPng: Buffer;
  const modelCall = vi.fn<GeminiImageCaller["call"]>(async (_key, _prompt, _source) => ({
    bytes: generatedPng,
    mimeType: "image/png",
    usage: {
      promptTokenCount: 100,
      candidatesTokenCount: 1120,
      thoughtsTokenCount: 10,
      candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }],
    },
    outcome: "completed" as const,
    responseMs: 100,
  }));

  beforeAll(async () => {
    mediaDir = await mkdtemp(path.join(tmpdir(), "pubrick-media-test-"));
    process.env.MEDIA_STORAGE_DIR = mediaDir;
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    generatedPng = await sharp({
      create: { width: 4, height: 3, channels: 3, background: "#ffcc00" },
    })
      .png()
      .toBuffer();
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(GeminiImageCaller)
      .useValue({ call: modelCall })
      .compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    app.setGlobalPrefix("api");
    await app.init();
    await app.listen(0);
    direct = createDb(url as string);
  });

  afterAll(async () => {
    await app.close();
    await direct.pool.end();
    await rm(mediaDir, { recursive: true, force: true });
  });

  beforeEach(() => modelCall.mockClear());

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

  it("accepts a VK cover with text beyond Telegram's caption limit", async () => {
    const owner = await agent();
    const brand = await owner.post("/api/brands").send({ name: "VK brand" }).expect(201);
    const channel = await owner
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "vk",
        name: "VK wall",
        credentials: { accessToken: "test-user-token", groupId: "12345" },
      })
      .expect(201);
    const post = await owner
      .post("/api/content")
      .send({ brandId: brand.body.id, body: "x".repeat(1025), channelIds: [channel.body.id] })
      .expect(201);
    const image = await owner
      .post(`/api/media?brandId=${brand.body.id}`)
      .attach("file", generatedPng, { filename: "cover.png", contentType: "image/png" })
      .expect(201);
    await owner
      .patch(`/api/media/posts/${post.body.id}/cover`)
      .send({ mediaId: image.body.id })
      .expect(200);
    const approved = await owner.post(`/api/content/${post.body.id}/approve`).send({}).expect(200);
    expect(approved.body.adaptations[0].status).toBe("queued");
  });

  it("approves a Telegram, VK, and MAX cover when only Telegram has a short caption", async () => {
    const owner = await agent();
    const brand = await owner.post("/api/brands").send({ name: "Mixed brand" }).expect(201);
    const telegram = await owner
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "telegram",
        name: "Telegram",
        credentials: { botToken: "123:abc", chatId: "-1001234567890" },
      })
      .expect(201);
    const vk = await owner
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "vk",
        name: "VK",
        credentials: { accessToken: "test-user-token", groupId: "12345" },
      })
      .expect(201);
    const max = await owner
      .post("/api/channels")
      .send({
        brandId: brand.body.id,
        platform: "max",
        name: "MAX channel",
        credentials: { accessToken: "test-max-token", chatId: "-12345" },
      })
      .expect(201);
    const post = await owner
      .post("/api/content")
      .send({
        brandId: brand.body.id,
        body: "x".repeat(1025),
        channelIds: [telegram.body.id, vk.body.id, max.body.id],
      })
      .expect(201);
    const telegramAdaptation = post.body.adaptations.find(
      (row: { channelId: string }) => row.channelId === telegram.body.id,
    );
    await owner
      .patch(`/api/content/${post.body.id}/adaptations/${telegramAdaptation.id}`)
      .send({ body: "Short Telegram caption" })
      .expect(200);
    const image = await owner
      .post(`/api/media?brandId=${brand.body.id}`)
      .attach("file", generatedPng, { filename: "cover.png", contentType: "image/png" })
      .expect(201);
    await owner
      .patch(`/api/media/posts/${post.body.id}/cover`)
      .send({ mediaId: image.body.id })
      .expect(200);
    const approved = await owner.post(`/api/content/${post.body.id}/approve`).send({}).expect(200);
    expect(approved.body.adaptations.map((row: { status: string }) => row.status)).toEqual([
      "queued",
      "queued",
      "queued",
    ]);
  });

  it("bills an explicit Gemini generation and keeps the new image detached for review", async () => {
    const owner = await agent();
    const brand = await owner.post("/api/brands").send({ name: "Image brand" }).expect(201);
    await owner
      .put("/api/ai-credentials")
      .send({ provider: "google", apiKey: "test-google-key" })
      .expect(200);
    const created = await owner
      .post("/api/media/generate")
      .send({ brandId: brand.body.id, prompt: "A golden ceramic vase on a table" })
      .expect(201);
    expect(created.body).toMatchObject({
      brandId: brand.body.id,
      mimeType: "image/jpeg",
      width: 4,
      height: 3,
    });
    expect(mediaAssetDtoSchema.safeParse(created.body).success).toBe(true);
    expect(modelCall).toHaveBeenCalledWith(
      "test-google-key",
      "A golden ceramic vase on a table",
      undefined,
    );
    const saved = await readFile(path.join(mediaDir, `${created.body.id}.jpg`));
    expect((await sharp(saved).metadata()).format).toBe("jpeg");
    const assetRows = await direct.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.id, created.body.id));
    const rows = await direct.db
      .select()
      .from(schema.usageLedger)
      .where(eq(schema.usageLedger.step, "image_generate"));
    const ledger = rows.find((row) => row.orgId === assetRows[0]?.orgId);
    expect(ledger).toMatchObject({
      provider: "google",
      modelId: "gemini-3.1-flash-image",
      costSource: "price_table",
      outcome: "completed",
    });
    expect(Number(ledger?.costUsd)).toBeGreaterThan(0);
  });

  it("regenerates only from a same-brand image and preserves the source", async () => {
    const owner = await agent();
    const stranger = await agent();
    const brand = await owner.post("/api/brands").send({ name: "Image brand" }).expect(201);
    const other = await owner.post("/api/brands").send({ name: "Other brand" }).expect(201);
    await owner
      .put("/api/ai-credentials")
      .send({ provider: "google", apiKey: "test-google-key" })
      .expect(200);
    const source = await owner
      .post(`/api/media?brandId=${brand.body.id}`)
      .attach("file", generatedPng, { filename: "source.png", contentType: "image/png" })
      .expect(201);
    const blocked = {
      brandId: other.body.id,
      prompt: "Change the background to blue",
      sourceMediaId: source.body.id,
    };
    await owner.post("/api/media/generate").send(blocked).expect(404);
    await stranger
      .post("/api/media/generate")
      .send({ ...blocked, brandId: brand.body.id })
      .expect(404);
    expect(modelCall).not.toHaveBeenCalled();
    const variant = await owner
      .post("/api/media/generate")
      .send({ ...blocked, brandId: brand.body.id })
      .expect(201);
    expect(variant.body.id).not.toBe(source.body.id);
    expect(modelCall.mock.calls[0]?.[2]).toEqual(
      await readFile(path.join(mediaDir, `${source.body.id}.jpg`)),
    );
    await owner.get(`/api/media/${source.body.id}/file`).expect(200);
    await owner.get(`/api/media/${variant.body.id}/file`).expect(200);
  });

  it("refuses calls without a Google key and records an uncertain billed call without an asset", async () => {
    const owner = await agent();
    const brand = await owner.post("/api/brands").send({ name: "Image brand" }).expect(201);
    const body = { brandId: brand.body.id, prompt: "A blue ceramic vase on a table" };
    await owner.post("/api/media/generate").send(body).expect(404);
    expect(modelCall).not.toHaveBeenCalled();
    await owner
      .put("/api/ai-credentials")
      .send({ provider: "google", apiKey: "test-google-key" })
      .expect(200);
    modelCall.mockImplementationOnce(async () => ({ outcome: "unknown", responseMs: 120000 }));
    await owner.post("/api/media/generate").send(body).expect(409);
    const assets = await owner.get(`/api/media?brandId=${brand.body.id}`).expect(200);
    expect(assets.body).toEqual([]);
    const brandRows = await direct.db
      .select()
      .from(schema.brands)
      .where(eq(schema.brands.id, brand.body.id));
    expect(brandRows).toHaveLength(1);
    const rows = await direct.db
      .select()
      .from(schema.usageLedger)
      .where(eq(schema.usageLedger.orgId, brandRows[0]?.orgId ?? ""));
    expect(rows).toContainEqual(
      expect.objectContaining({
        step: "image_generate",
        outcome: "unknown",
        costSource: "unknown",
        status: "errored",
      }),
    );
  });

  it("stops an organization at its hourly image call budget before contacting Gemini", async () => {
    const owner = await agent();
    const brand = await owner.post("/api/brands").send({ name: "Budget brand" }).expect(201);
    await owner
      .put("/api/ai-credentials")
      .send({ provider: "google", apiKey: "test-google-key" })
      .expect(200);
    const brandRows = await direct.db
      .select({ orgId: schema.brands.orgId })
      .from(schema.brands)
      .where(eq(schema.brands.id, brand.body.id));
    expect(brandRows).toHaveLength(1);
    await direct.db.insert(schema.usageLedger).values(
      Array.from({ length: 12 }, () => ({
        orgId: brandRows[0]?.orgId ?? "",
        step: "image_generate",
        provider: "google" as const,
        modelId: "gemini-3.1-flash-image",
        costSource: "unknown" as const,
        status: "ok" as const,
        outcome: "completed" as const,
      })),
    );
    const response = await owner
      .post("/api/media/generate")
      .send({ brandId: brand.body.id, prompt: "An editorial photo of a blue vase" })
      .expect(409);
    expect(response.body.code).toBe("media_generation_limit");
    expect(modelCall).not.toHaveBeenCalled();
  });
});
