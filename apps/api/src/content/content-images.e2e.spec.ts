import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { createDb, schema } from "@pubrick/db";
import { contentImagesStateSchema } from "@pubrick/shared";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("article image slots e2e", () => {
  let app: INestApplication;
  let mediaDir: string;
  let direct: ReturnType<typeof createDb>;
  let png: Buffer;

  beforeAll(async () => {
    mediaDir = await mkdtemp(path.join(tmpdir(), "pubrick-article-images-"));
    process.env.MEDIA_STORAGE_DIR = mediaDir;
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    png = await sharp({ create: { width: 3, height: 2, channels: 3, background: "#26a69a" } })
      .png()
      .toBuffer();
    const { AppModule } = await import("../app.module");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
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

  async function agent() {
    const client = request.agent(app.getHttpServer());
    const unique = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
    await client
      .post("/api/auth/sign-up/email")
      .send({ email: `images-${unique}@example.com`, password: "password1234", name: "Editor" })
      .expect(200);
    const org = await client
      .post("/api/auth/organization/create")
      .send({ name: `Images ${unique}`, slug: `images-${unique}` })
      .expect(200);
    await client
      .post("/api/auth/organization/set-active")
      .send({ organizationId: org.body.id })
      .expect(200);
    return client;
  }

  async function post(
    client: request.Agent,
    brandId: string,
    body = "First.\n\nSecond.\n\nThird.",
  ) {
    const channel = await client
      .post("/api/channels")
      .send({
        brandId,
        platform: "telegram",
        name: "Article channel",
        credentials: { botToken: "123:abc", chatId: "-1001234567890" },
      })
      .expect(201);
    return client
      .post("/api/content")
      .send({ brandId, title: "Article", body, channelIds: [channel.body.id] })
      .expect(201);
  }

  async function upload(client: request.Agent, brandId: string) {
    return client
      .post(`/api/media?brandId=${brandId}`)
      .attach("file", png, { filename: "inline.png", contentType: "image/png" })
      .expect(201);
  }

  it("orders atomic replacements and keeps the plain body intact", async () => {
    const owner = await agent();
    const brand = await owner.post("/api/brands").send({ name: "Longform" }).expect(201);
    const item = await post(owner, brand.body.id);
    const imageA = await upload(owner, brand.body.id);
    const imageB = await upload(owner, brand.body.id);
    const uri = `/api/content/${item.body.id}/images`;
    const saved = await owner
      .put(uri)
      .send({
        expectedRevision: 0,
        images: [
          { mediaId: imageB.body.id, afterParagraph: 2, alt: "Final illustration" },
          {
            mediaId: imageA.body.id,
            afterParagraph: 0,
            alt: "Opening illustration",
            caption: "Opening",
          },
        ],
      })
      .expect(200);
    expect(
      saved.body.images.map((slot: { afterParagraph: number }) => slot.afterParagraph),
    ).toEqual([0, 2]);
    expect(contentImagesStateSchema.safeParse(saved.body).success).toBe(true);
    expect(saved.body.revision).toBe(1);
    expect((await owner.get(uri).expect(200)).body).toEqual(saved.body);
    expect((await owner.get(`/api/content/${item.body.id}`).expect(200)).body.body).toBe(
      "First.\n\nSecond.\n\nThird.",
    );
    await owner.delete(`/api/media/${imageA.body.id}`).expect(409);

    const invalid = await owner
      .put(uri)
      .send({
        expectedRevision: 1,
        images: [{ mediaId: imageA.body.id, afterParagraph: 3, alt: "Outside body" }],
      })
      .expect(400);
    expect(invalid.body.code).toBe("content_image_position_invalid");
    expect((await owner.get(uri).expect(200)).body).toEqual(saved.body);
    await owner
      .put(uri)
      .send({
        expectedRevision: 1,
        images: [
          { mediaId: imageA.body.id, afterParagraph: 0, alt: "A" },
          { mediaId: imageB.body.id, afterParagraph: 0, alt: "B" },
        ],
      })
      .expect(400);
    await owner
      .put(uri)
      .send({
        expectedRevision: 1,
        images: [{ mediaId: imageA.body.id, afterParagraph: 0, alt: "   " }],
      })
      .expect(400);
    await owner
      .put(uri)
      .send({
        expectedRevision: 1,
        images: Array.from({ length: 6 }, (_, index) => ({
          mediaId: imageA.body.id,
          afterParagraph: index,
          alt: `Illustration ${index}`,
        })),
      })
      .expect(400);

    const edit = await owner
      .patch(`/api/content/${item.body.id}`)
      .send({ body: "Only one paragraph." })
      .expect(409);
    expect(edit.body.code).toBe("content_image_body_conflict");
    await expect(
      direct.db
        .update(schema.contentItems)
        .set({ body: "Only one paragraph." })
        .where(eq(schema.contentItems.id, item.body.id)),
    ).rejects.toMatchObject({
      cause: { code: "23514", constraint: "content_image_slots_body_position_check" },
    });
    await expect(
      direct.db
        .update(schema.contentItems)
        .set({ body: "First.\r\n\r\n\t\r\n\r\nSecond." })
        .where(eq(schema.contentItems.id, item.body.id)),
    ).rejects.toMatchObject({ cause: { code: "23514" } });

    await owner.put(uri).send({ images: [], expectedRevision: 1 }).expect(200);
    await owner.delete(`/api/media/${imageA.body.id}`).expect(204);
    await owner.delete(`/api/media/${imageB.body.id}`).expect(204);
  });

  it("rejects cross-brand, cross-tenant, video, and pinned-post attachments", async () => {
    const owner = await agent();
    const stranger = await agent();
    const brand = await owner.post("/api/brands").send({ name: "Article" }).expect(201);
    const otherBrand = await owner.post("/api/brands").send({ name: "Other" }).expect(201);
    const strangerBrand = await stranger.post("/api/brands").send({ name: "Stranger" }).expect(201);
    const item = await post(owner, brand.body.id);
    const ownImage = await upload(owner, brand.body.id);
    const otherImage = await upload(owner, otherBrand.body.id);
    const strangerImage = await upload(stranger, strangerBrand.body.id);
    const videoBytes = await readFile(
      path.resolve(process.cwd(), "src/media/fixtures/tiny-h264.mp4"),
    );
    const video = await owner
      .post(`/api/media?brandId=${brand.body.id}`)
      .attach("file", videoBytes, { filename: "clip.mp4", contentType: "video/mp4" })
      .expect(201);
    const uri = `/api/content/${item.body.id}/images`;
    await stranger.get(uri).expect(404);
    await stranger.put(uri).send({ images: [], expectedRevision: 0 }).expect(404);
    for (const mediaId of [otherImage.body.id, strangerImage.body.id, video.body.id]) {
      const refused = await owner
        .put(uri)
        .send({ expectedRevision: 0, images: [{ mediaId, afterParagraph: 0, alt: "Wrong brand" }] })
        .expect(404);
      expect(refused.body.code).toBe("media_not_found");
    }
    const [brandRow] = await direct.db
      .select({ orgId: schema.brands.orgId })
      .from(schema.brands)
      .where(eq(schema.brands.id, brand.body.id));
    if (!brandRow) throw new Error("Test brand is missing");
    await expect(
      direct.db.insert(schema.contentImageSlots).values({
        orgId: brandRow.orgId,
        brandId: otherBrand.body.id,
        contentItemId: item.body.id,
        mediaId: otherImage.body.id,
        afterParagraph: 0,
        alt: "Wrong brand",
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
    expect((await owner.get(uri).expect(200)).body).toEqual({ images: [], revision: 0 });
    await owner
      .put(uri)
      .send({
        expectedRevision: 0,
        images: [{ mediaId: ownImage.body.id, afterParagraph: 1, alt: "Valid" }],
      })
      .expect(200);
    await direct.db
      .update(schema.contentItems)
      .set({ status: "approved" })
      .where(eq(schema.contentItems.id, item.body.id));
    const pinned = await owner.put(uri).send({ images: [], expectedRevision: 1 }).expect(409);
    expect(pinned.body.code).toBe("content_media_pinned");
    expect((await owner.get(uri).expect(200)).body.images).toHaveLength(1);
    await owner.delete(`/api/brands/${brand.body.id}`).expect(200);
    await owner.get(uri).expect(404);
  });

  it("requires explicit review of generated images before approval", async () => {
    const owner = await agent();
    const brand = await owner.post("/api/brands").send({ name: "Illustrated article" }).expect(201);
    const item = await post(owner, brand.body.id);
    const image = await upload(owner, brand.body.id);
    const uri = `/api/content/${item.body.id}/images`;
    await owner
      .put(uri)
      .send({
        expectedRevision: 0,
        images: [{ mediaId: image.body.id, afterParagraph: 0, alt: "Draft description" }],
      })
      .expect(200);
    await direct.db
      .update(schema.contentImageSlots)
      .set({ needsReview: true })
      .where(eq(schema.contentImageSlots.contentItemId, item.body.id));

    const before = await owner.get(uri).expect(200);
    expect(before.body.images[0].needsReview).toBe(true);
    const refusal = await owner.post(`/api/content/${item.body.id}/approve`).send({}).expect(409);
    expect(refusal.body.code).toBe("content_images_need_review");

    const noAcknowledgment = await owner
      .put(uri)
      .send({
        expectedRevision: before.body.revision,
        images: [{ mediaId: image.body.id, afterParagraph: 1, alt: "Reviewed description" }],
      })
      .expect(200);
    expect(noAcknowledgment.body.images[0].needsReview).toBe(true);
    expect(noAcknowledgment.body.images[0].afterParagraph).toBe(1);
    const acknowledged = await owner
      .put(uri)
      .send({
        expectedRevision: noAcknowledgment.body.revision,
        reviewGeneratedImages: true,
        images: [{ mediaId: image.body.id, afterParagraph: 1, alt: "Reviewed description" }],
      })
      .expect(200);
    expect(acknowledged.body.images[0].needsReview).toBe(false);
    await owner.post(`/api/content/${item.body.id}/approve`).send({}).expect(200);
  });

  it("refuses a stale whole-set save without erasing another editor's images", async () => {
    const owner = await agent();
    const brand = await owner.post("/api/brands").send({ name: "Editors" }).expect(201);
    const item = await post(owner, brand.body.id);
    // Rows written before migration 0064 remain NULL: the API exposes zero
    // until the first successful replacement claims revision one.
    await direct.db
      .update(schema.contentItems)
      .set({ imagesRevision: null })
      .where(eq(schema.contentItems.id, item.body.id));
    const imageA = await upload(owner, brand.body.id);
    const imageB = await upload(owner, brand.body.id);
    const uri = `/api/content/${item.body.id}/images`;
    const firstRead = await owner.get(uri).expect(200);
    const secondRead = await owner.get(uri).expect(200);
    expect(firstRead.body.revision).toBe(0);
    expect(secondRead.body.revision).toBe(0);

    const firstSave = await owner
      .put(uri)
      .send({
        expectedRevision: firstRead.body.revision,
        images: [{ mediaId: imageA.body.id, afterParagraph: 0, alt: "First editor" }],
      })
      .expect(200);
    expect(firstSave.body.revision).toBe(1);
    const stale = await owner
      .put(uri)
      .send({
        expectedRevision: secondRead.body.revision,
        images: [{ mediaId: imageB.body.id, afterParagraph: 1, alt: "Second editor" }],
      })
      .expect(409);
    expect(stale.body.code).toBe("content_images_changed");
    expect((await owner.get(uri).expect(200)).body).toEqual(firstSave.body);

    const concurrent = await Promise.all([
      owner.put(uri).send({
        expectedRevision: 1,
        images: [{ mediaId: imageA.body.id, afterParagraph: 2, alt: "Third editor" }],
      }),
      owner.put(uri).send({
        expectedRevision: 1,
        images: [{ mediaId: imageB.body.id, afterParagraph: 1, alt: "Fourth editor" }],
      }),
    ]);
    expect(concurrent.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = concurrent.find((response) => response.status === 200);
    expect((await owner.get(uri).expect(200)).body).toEqual(winner?.body);
    expect(winner?.body.revision).toBe(2);
  });

  it("deletes an organization containing both draft slots and public image snapshots", async () => {
    const owner = await agent();
    const brand = await owner.post("/api/brands").send({ name: "Cascading images" }).expect(201);
    const item = await post(owner, brand.body.id);
    const image = await upload(owner, brand.body.id);
    await owner
      .put(`/api/content/${item.body.id}/images`)
      .send({
        expectedRevision: 0,
        images: [{ mediaId: image.body.id, afterParagraph: 0, alt: "Illustration" }],
      })
      .expect(200);
    await direct.db
      .update(schema.contentItems)
      .set({ status: "published" })
      .where(eq(schema.contentItems.id, item.body.id));
    await owner.post(`/api/brands/${brand.body.id}/feed`).expect(201);
    await owner.post(`/api/brands/${brand.body.id}/feed/items/${item.body.id}`).expect(201);
    const [brandRow] = await direct.db
      .select({ orgId: schema.brands.orgId })
      .from(schema.brands)
      .where(eq(schema.brands.id, brand.body.id));
    if (!brandRow) throw new Error("Test brand is missing");
    await direct.db.delete(schema.organization).where(eq(schema.organization.id, brandRow.orgId));
    expect(
      await direct.db
        .select({ id: schema.mediaAssets.id })
        .from(schema.mediaAssets)
        .where(eq(schema.mediaAssets.id, image.body.id)),
    ).toEqual([]);
  });
});
