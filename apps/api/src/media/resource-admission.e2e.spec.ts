import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HttpException } from "@nestjs/common";
import { createDb, schema, type TenantResourceQuotaMode } from "@pubrick/db";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { BrandsRepository } from "../brands/brands.repository";
import type { ChannelsRepository } from "../channels/channels.repository";
import type { ContentImagesRepository } from "../content/content-images.repository";
import type { MediaRepository } from "./media.repository";

const controls = vi.hoisted(() => ({
  mode: {
    mode: "hosted",
    identity: { provider: "stripe", environment: "sandbox", accountId: "acct_writer_operator" },
  } as TenantResourceQuotaMode,
  afterCropWrite: undefined as (() => Promise<void>) | undefined,
}));
vi.mock("../tenant-quota", async (original) => ({
  ...(await original<typeof import("../tenant-quota")>()),
  tenantQuotaMode: () => controls.mode,
}));
vi.mock("../content/content-image-file", async (original) => {
  const actual = await original<typeof import("../content/content-image-file")>();
  return {
    writeCropFile: async (...args: Parameters<typeof actual.writeCropFile>) => {
      await actual.writeCropFile(...args);
      await controls.afterCropWrite?.();
    },
  };
});
const url = process.env.TEST_DATABASE_URL;
describe.skipIf(!url)("native API resource writers", () => {
  let connection: ReturnType<typeof createDb>;
  let mediaDir: string;
  let brands: BrandsRepository;
  let channels: ChannelsRepository;
  let media: MediaRepository;
  let images: ContentImagesRepository;
  let png: Buffer;
  const orgIds: string[] = [];
  const planIds: string[] = [];
  beforeAll(async () => {
    process.env.DATABASE_URL = url as string;
    process.env.BETTER_AUTH_SECRET ??= "pubrick-test-secret";
    process.env.APP_ENCRYPTION_KEY ??= "6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=";
    mediaDir = await mkdtemp(path.join(tmpdir(), "pubrick-resource-writers-"));
    process.env.MEDIA_STORAGE_DIR = mediaDir;
    connection = createDb(url as string);
    const b = await import("../brands/brands.repository");
    const c = await import("../channels/channels.repository");
    const m = await import("./media.repository");
    const i = await import("../content/content-images.repository");
    // Only these database repository methods run. No queue or image model call.
    brands = new b.BrandsRepository({} as ConstructorParameters<typeof b.BrandsRepository>[0]);
    channels = new c.ChannelsRepository(
      {} as ConstructorParameters<typeof c.ChannelsRepository>[0],
    );
    media = new m.MediaRepository();
    images = new i.ContentImagesRepository(
      {} as ConstructorParameters<typeof i.ContentImagesRepository>[0],
    );
    png = await sharp({ create: { width: 8, height: 6, channels: 3, background: "#26a69a" } })
      .png()
      .toBuffer();
  });
  afterAll(async () => {
    if (!connection) return;
    for (const orgId of orgIds) {
      await connection.db.delete(schema.organization).where(eq(schema.organization.id, orgId));
      await connection.db
        .delete(schema.billingSubscriptions)
        .where(eq(schema.billingSubscriptions.orgId, orgId));
    }
    for (const id of planIds)
      await connection.db
        .delete(schema.billingPlanVersions)
        .where(eq(schema.billingPlanVersions.id, id));
    await connection.pool.end();
    const { pool } = await import("../db");
    await pool.end();
    await rm(mediaDir, { recursive: true, force: true });
  });
  async function fixture(limits: Partial<schema.BillingLimits> = {}) {
    const orgId = randomUUID();
    orgIds.push(orgId);
    await connection.db
      .insert(schema.organization)
      .values({ id: orgId, name: "Writer fixture", slug: orgId });
    const planId = randomUUID();
    planIds.push(planId);
    const identity = {
      provider: "stripe",
      environment: "sandbox",
      accountId: "acct_writer_operator",
    };
    const priceId = `price_${planId}`;
    await connection.db.insert(schema.billingPlanVersions).values({
      id: planId,
      ...identity,
      planId: "writer-fixture",
      version: planId,
      priceId,
      price: {
        priceId,
        productId: `product_${planId}`,
        currency: "usd",
        unitAmount: 100,
        interval: "month",
        intervalCount: 1,
      },
      limits: {
        seats: 2,
        brands: 2,
        channels: 1,
        mediaBytes: 100_000,
        concurrentJobs: 1,
        ...limits,
      },
    });
    const subscriptionId = `sub_${orgId}`;
    const periodEnd = new Date(Date.now() + 86400000);
    await connection.db.insert(schema.billingSubscriptions).values({
      orgId,
      ...identity,
      customerId: `cus_${orgId}`,
      subscriptionId,
      status: "active",
      priceId,
      planVersionId: planId,
      periodStart: new Date(Date.now() - 3600000),
      periodEnd,
      cancelAtPeriodEnd: false,
    });
    await connection.db.insert(schema.organizationBillingState).values({
      orgId,
      subscriptionId,
      planVersionId: planId,
      access: true,
      accessUntil: periodEnd,
    });
    const [brand] = await connection.db
      .insert(schema.brands)
      .values({ orgId, name: "Existing brand" })
      .returning();
    if (!brand) throw new Error("Missing fixture brand");
    return { orgId, brandId: brand.id, planId };
  }
  async function assertQuota(error: unknown, resource: string) {
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(409);
    expect((error as HttpException).getResponse()).toMatchObject({
      code: "resource_limit",
      resource,
    });
  }
  it("admits exactly one simultaneous brand at the final available brand slot and commits no refused row", async () => {
    const f = await fixture({ brands: 2 });
    const results = await Promise.allSettled([
      brands.create(f.orgId, { name: "One", contentLanguage: "en", automaticClaimEvidence: false }),
      brands.create(f.orgId, { name: "Two", contentLanguage: "en", automaticClaimEvidence: false }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refusal = results.find((r) => r.status === "rejected");
    if (refusal?.status !== "rejected") throw new Error("Expected quota refusal");
    await assertQuota(refusal.reason, "brands");
    expect(
      await connection.db.select().from(schema.brands).where(eq(schema.brands.orgId, f.orgId)),
    ).toHaveLength(2);
  });
  it("serializes concurrent manual channels without using publisher credentials", async () => {
    const f = await fixture();
    const results = await Promise.allSettled(
      ["One", "Two"].map((name) =>
        channels.create(f.orgId, { brandId: f.brandId, platform: "vc_ru", name }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refusal = results.find((r) => r.status === "rejected");
    if (refusal?.status !== "rejected") throw new Error("Expected quota refusal");
    await assertQuota(refusal.reason, "channels");
    expect(
      await connection.db.select().from(schema.channels).where(eq(schema.channels.orgId, f.orgId)),
    ).toHaveLength(1);
  });
  it("counts normalized JPEG bytes and removes the prepared file on refused image upload", async () => {
    const f = await fixture({ mediaBytes: 1 });
    const before = await readdir(mediaDir);
    await assertQuota(
      await media
        .upload(f.orgId, f.brandId, {
          buffer: png,
          originalname: "fixture.png",
          mimetype: "image/png",
        })
        .catch((error) => error),
      "mediaBytes",
    );
    expect(await readdir(mediaDir)).toEqual(before);
    expect(
      await connection.db
        .select()
        .from(schema.mediaAssets)
        .where(eq(schema.mediaAssets.orgId, f.orgId)),
    ).toHaveLength(0);
  });
  it("removes a validated MP4 prepared before its byte quota refusal", async () => {
    const f = await fixture({ mediaBytes: 1 });
    const video = await readFile(path.resolve(process.cwd(), "src/media/fixtures/tiny-h264.mp4"));
    const before = await readdir(mediaDir);
    await assertQuota(
      await media
        .upload(f.orgId, f.brandId, {
          buffer: video,
          originalname: "fixture.mp4",
          mimetype: "video/mp4",
        })
        .catch((error) => error),
      "mediaBytes",
    );
    expect(await readdir(mediaDir)).toEqual(before);
    expect(
      await connection.db
        .select()
        .from(schema.mediaAssets)
        .where(eq(schema.mediaAssets.orgId, f.orgId)),
    ).toHaveLength(0);
  });
  it("allows expired workspaces to delete media and removes committed disk bytes", async () => {
    const f = await fixture();
    const asset = await media.upload(f.orgId, f.brandId, {
      buffer: png,
      originalname: "fixture.png",
      mimetype: "image/png",
    });
    if (!asset) throw new Error("Missing uploaded fixture image");
    await connection.db
      .update(schema.organizationBillingState)
      .set({ access: false })
      .where(eq(schema.organizationBillingState.orgId, f.orgId));
    await media.delete(f.orgId, asset.id);
    await expect(readFile(path.join(mediaDir, `${asset.id}.jpg`))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await connection.db
        .select()
        .from(schema.mediaAssets)
        .where(eq(schema.mediaAssets.id, asset.id)),
    ).toHaveLength(0);
  });
  async function cropFixture() {
    const f = await fixture();
    const asset = await media.upload(f.orgId, f.brandId, {
      buffer: png,
      originalname: "source.png",
      mimetype: "image/png",
    });
    if (!asset) throw new Error("Missing uploaded fixture image");
    const [item] = await connection.db
      .insert(schema.contentItems)
      .values({ orgId: f.orgId, brandId: f.brandId, body: "Paragraph.", imagesRevision: 1 })
      .returning();
    if (!item) throw new Error("Missing fixture content");
    const [slot] = await connection.db
      .insert(schema.contentImageSlots)
      .values({
        orgId: f.orgId,
        brandId: f.brandId,
        contentItemId: item.id,
        mediaId: asset.id,
        afterParagraph: 0,
        alt: "Image",
      })
      .returning();
    if (!slot) throw new Error("Missing fixture slot");
    return {
      ...f,
      asset,
      item,
      slot,
      crop: { expectedRevision: 1, sourceMediaId: asset.id, x: 0, y: 0, width: 4, height: 3 },
    };
  }
  it("commits an admitted crop with exact normalized byte metadata and atomic slot revision", async () => {
    const f = await cropFixture();
    const result = await images.crop(f.orgId, f.item.id, f.slot.id, f.crop);
    expect(result.revision).toBe(2);
    const image = result.images[0];
    if (!image) throw new Error("Missing cropped slot");
    expect(image.needsReview).toBe(true);
    const [asset] = await connection.db
      .select()
      .from(schema.mediaAssets)
      .where(eq(schema.mediaAssets.id, image.mediaId));
    if (!asset) throw new Error("Missing cropped media");
    const bytes = await readFile(path.join(mediaDir, `${asset.id}.jpg`));
    expect(asset.byteSize).toBe(bytes.length);
    expect(await sharp(bytes).metadata()).toMatchObject({ format: "jpeg", width: 4, height: 3 });
  });
  it("rolls back a refused crop without changing slot/revision or retaining its prepared file", async () => {
    const f = await cropFixture();
    const [plan] = await connection.db
      .select()
      .from(schema.billingPlanVersions)
      .where(eq(schema.billingPlanVersions.id, f.planId));
    if (!plan) throw new Error("Missing fixture plan");
    await connection.db
      .update(schema.billingPlanVersions)
      .set({ limits: { ...plan.limits, mediaBytes: f.asset.byteSize } })
      .where(eq(schema.billingPlanVersions.id, f.planId));
    const before = await readdir(mediaDir);
    await assertQuota(
      await images.crop(f.orgId, f.item.id, f.slot.id, f.crop).catch((error) => error),
      "mediaBytes",
    );
    expect(await readdir(mediaDir)).toEqual(before);
    const saved = await images.list(f.orgId, f.item.id);
    expect(saved.revision).toBe(1);
    expect(saved.images[0]?.mediaId).toBe(f.asset.id);
  });
  it("allows an editor to commit during crop processing, then rejects and cleans stale output", async () => {
    const f = await cropFixture();
    const before = await readdir(mediaDir);
    controls.afterCropWrite = async () => {
      await connection.db
        .update(schema.contentItems)
        .set({ imagesRevision: 2 })
        .where(eq(schema.contentItems.id, f.item.id));
    };
    try {
      await expect(images.crop(f.orgId, f.item.id, f.slot.id, f.crop)).rejects.toMatchObject({
        response: { code: "content_images_changed" },
      });
    } finally {
      controls.afterCropWrite = undefined;
    }
    expect(await readdir(mediaDir)).toEqual(before);
    expect((await images.list(f.orgId, f.item.id)).revision).toBe(2);
    expect(
      await connection.db
        .select()
        .from(schema.mediaAssets)
        .where(eq(schema.mediaAssets.orgId, f.orgId)),
    ).toHaveLength(1);
  });
  it("retains source disappearance fencing and removes the new crop file", async () => {
    const f = await cropFixture();
    const before = await readdir(mediaDir);
    controls.afterCropWrite = async () => {
      await connection.db
        .delete(schema.contentImageSlots)
        .where(eq(schema.contentImageSlots.id, f.slot.id));
      await connection.db.delete(schema.mediaAssets).where(eq(schema.mediaAssets.id, f.asset.id));
    };
    try {
      await expect(images.crop(f.orgId, f.item.id, f.slot.id, f.crop)).rejects.toMatchObject({
        response: { code: "content_image_not_found" },
      });
    } finally {
      controls.afterCropWrite = undefined;
    }
    expect(await readdir(mediaDir)).toEqual(before);
  });
});
