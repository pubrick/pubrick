import { randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Injectable, Logger } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { and, desc, eq } from "drizzle-orm";
import sharp from "sharp";
import { badRequest, conflict, notFound } from "../api-error";
import { db } from "../db";

export const MEDIA_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const TELEGRAM_CAPTION_LIMIT = 1024;

export function mediaPath(id: string): string {
  // The id is generated server-side and all HTTP readers pass ParseUUIDPipe.
  return path.join(
    process.env.MEDIA_STORAGE_DIR ?? path.resolve(process.cwd(), ".data/media"),
    `${id}.jpg`,
  );
}

const COLUMNS = {
  id: schema.mediaAssets.id,
  brandId: schema.mediaAssets.brandId,
  name: schema.mediaAssets.name,
  mimeType: schema.mediaAssets.mimeType,
  width: schema.mediaAssets.width,
  height: schema.mediaAssets.height,
  byteSize: schema.mediaAssets.byteSize,
  createdAt: schema.mediaAssets.createdAt,
};

@Injectable()
export class MediaRepository {
  private readonly logger = new Logger(MediaRepository.name);
  async list(orgId: string, brandId: string, offset = 0) {
    await this.requireBrand(orgId, brandId);
    return db
      .select(COLUMNS)
      .from(schema.mediaAssets)
      .where(and(eq(schema.mediaAssets.orgId, orgId), eq(schema.mediaAssets.brandId, brandId)))
      .orderBy(desc(schema.mediaAssets.createdAt), desc(schema.mediaAssets.id))
      .limit(100)
      .offset(offset);
  }

  async upload(
    orgId: string,
    brandId: string,
    file?: { buffer: Buffer; originalname: string; mimetype: string },
  ) {
    await this.requireBrand(orgId, brandId);
    if (
      !file?.buffer ||
      file.buffer.length === 0 ||
      file.buffer.length > MEDIA_MAX_UPLOAD_BYTES ||
      !["image/jpeg", "image/png", "image/webp"].includes(file.mimetype)
    ) {
      throw badRequest("media_invalid", "Upload a JPEG, PNG, or WebP image up to 10 MB");
    }
    let normalized: Buffer;
    let width: number;
    let height: number;
    try {
      // Decoder validation is authoritative; request MIME alone is never trusted.
      const source = sharp(file.buffer, { limitInputPixels: 40_000_000, failOn: "error" });
      const info = await source.metadata();
      if (!["jpeg", "png", "webp"].includes(info.format ?? ""))
        throw new Error("Unsupported format");
      const output = await source
        .rotate()
        .resize({ width: 2400, height: 2400, fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 85, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
      normalized = output.data;
      width = output.info.width;
      height = output.info.height;
    } catch {
      throw badRequest("media_invalid", "The image could not be decoded as JPEG, PNG, or WebP");
    }
    const id = randomUUID();
    const target = mediaPath(id);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, normalized, { flag: "wx", mode: 0o600 });
    try {
      const rows = await db
        .insert(schema.mediaAssets)
        .values({
          id,
          orgId,
          brandId,
          name: path.basename(file.originalname).slice(0, 200) || "Image",
          mimeType: "image/jpeg",
          width,
          height,
          byteSize: normalized.length,
        })
        .returning(COLUMNS);
      return rows[0];
    } catch (error) {
      await unlink(target).catch(() => undefined);
      throw error;
    }
  }

  async file(orgId: string, id: string): Promise<Buffer> {
    await this.requireAsset(orgId, id);
    return readFile(mediaPath(id));
  }

  async delete(orgId: string, id: string): Promise<void> {
    await this.requireAsset(orgId, id);
    const attached = await db
      .select({ id: schema.contentItems.id })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.coverMediaId, id)))
      .limit(1);
    if (attached.length)
      throw conflict("media_in_use", "Remove this cover from its post before deleting it");
    const rows = await db
      .delete(schema.mediaAssets)
      .where(and(eq(schema.mediaAssets.orgId, orgId), eq(schema.mediaAssets.id, id)))
      .returning({ id: schema.mediaAssets.id });
    if (!rows.length) throw notFound("media_not_found", "Image not found");
    await unlink(mediaPath(id)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        this.logger.warn(
          `Could not remove deleted media file: mediaId=${id} error=${String(error)}`,
        );
      }
    });
  }

  async attach(orgId: string, itemId: string, mediaId: string | null) {
    return db.transaction(async (tx) => {
      const items = await tx
        .select({
          id: schema.contentItems.id,
          brandId: schema.contentItems.brandId,
          status: schema.contentItems.status,
          body: schema.contentItems.body,
        })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, itemId)))
        .for("update")
        .limit(1);
      const item = items[0];
      if (!item) throw notFound("content_not_found", "Post not found");
      if (!["draft", "rejected", "failed"].includes(item.status)) {
        throw conflict(
          "media_cover_pinned",
          "This post is already approved or published; reject it before changing its cover",
        );
      }
      if (mediaId) {
        const assets = await tx
          .select({ id: schema.mediaAssets.id })
          .from(schema.mediaAssets)
          .where(
            and(
              eq(schema.mediaAssets.orgId, orgId),
              eq(schema.mediaAssets.brandId, item.brandId),
              eq(schema.mediaAssets.id, mediaId),
            ),
          )
          .limit(1);
        if (!assets.length) throw notFound("media_not_found", "Image not found in this brand");
        const targets = await tx
          .select({ platform: schema.channels.platform, body: schema.adaptations.body })
          .from(schema.adaptations)
          .innerJoin(schema.channels, eq(schema.channels.id, schema.adaptations.channelId))
          .where(
            and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.contentItemId, itemId)),
          );
        if (targets.some((target) => target.platform !== "telegram")) {
          throw conflict(
            "content_media_unsupported",
            "Covers currently publish only to Telegram; remove other channels from this post",
          );
        }
        if (targets.some((target) => (target.body ?? item.body).length > TELEGRAM_CAPTION_LIMIT)) {
          throw conflict(
            "content_media_caption_too_long",
            "Telegram photo captions must be 1024 characters or fewer",
          );
        }
      }
      await tx
        .update(schema.contentItems)
        .set({ coverMediaId: mediaId })
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, itemId)));
      return { coverMediaId: mediaId };
    });
  }

  private async requireBrand(orgId: string, brandId: string): Promise<void> {
    const rows = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    if (!rows.length) throw notFound("brand_not_found", "Brand not found");
  }

  private async requireAsset(orgId: string, id: string): Promise<void> {
    const rows = await db
      .select({ id: schema.mediaAssets.id })
      .from(schema.mediaAssets)
      .where(and(eq(schema.mediaAssets.orgId, orgId), eq(schema.mediaAssets.id, id)))
      .limit(1);
    if (!rows.length) throw notFound("media_not_found", "Image not found");
  }
}
