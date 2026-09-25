import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Injectable, Logger } from "@nestjs/common";
import { schema } from "@pubrick/db";
import { and, desc, eq, or } from "drizzle-orm";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { badRequest, conflict, notFound } from "../api-error";
import { db } from "../db";
import { hasCompleteMp4Boxes } from "./mp4-validation";

export const IMAGE_MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const VIDEO_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MEDIA_MAX_UPLOAD_BYTES = VIDEO_MAX_UPLOAD_BYTES;
export const TELEGRAM_CAPTION_LIMIT = 1024;

export function mediaPath(id: string, kind: "image" | "video" = "image"): string {
  // The id is generated server-side and all HTTP readers pass ParseUUIDPipe.
  return path.join(
    process.env.MEDIA_STORAGE_DIR ?? path.resolve(process.cwd(), ".data/media"),
    `${id}.${kind === "image" ? "jpg" : "mp4"}`,
  );
}

const COLUMNS = {
  id: schema.mediaAssets.id,
  brandId: schema.mediaAssets.brandId,
  name: schema.mediaAssets.name,
  kind: schema.mediaAssets.kind,
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
    if (file?.mimetype === "video/mp4") return this.uploadVideo(orgId, brandId, file);
    if (
      !file?.buffer ||
      file.buffer.length === 0 ||
      file.buffer.length > IMAGE_MAX_UPLOAD_BYTES ||
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

  private async uploadVideo(
    orgId: string,
    brandId: string,
    file: { buffer: Buffer; originalname: string; mimetype: string },
  ) {
    if (!file.buffer || file.buffer.length < 1024 || file.buffer.length > VIDEO_MAX_UPLOAD_BYTES) {
      throw badRequest("media_invalid", "Upload an MP4 video between 1 KB and 20 MB");
    }
    let detected: Awaited<ReturnType<typeof fileTypeFromBuffer>>;
    try {
      detected = await fileTypeFromBuffer(file.buffer);
    } catch {
      throw badRequest("media_invalid", "The video has an invalid or truncated MP4 signature");
    }
    if (detected?.mime !== "video/mp4" || !hasCompleteMp4Boxes(file.buffer)) {
      throw badRequest("media_invalid", "The uploaded file is not a complete MP4 video");
    }
    const id = randomUUID();
    const target = mediaPath(id, "video");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.buffer, { flag: "wx", mode: 0o600 });
    try {
      const rows = await db
        .insert(schema.mediaAssets)
        .values({
          id,
          orgId,
          brandId,
          name: path.basename(file.originalname).slice(0, 200) || "Video",
          kind: "video",
          mimeType: "video/mp4",
          width: null,
          height: null,
          byteSize: file.buffer.length,
        })
        .returning(COLUMNS);
      return rows[0];
    } catch (error) {
      await unlink(target).catch(() => undefined);
      throw error;
    }
  }

  /** The only source allowed into an image edit is an asset in this brand. */
  async source(orgId: string, brandId: string, id: string): Promise<Buffer> {
    const rows = await db
      .select({ id: schema.mediaAssets.id })
      .from(schema.mediaAssets)
      .where(
        and(
          eq(schema.mediaAssets.orgId, orgId),
          eq(schema.mediaAssets.brandId, brandId),
          eq(schema.mediaAssets.id, id),
          eq(schema.mediaAssets.kind, "image"),
        ),
      )
      .limit(1);
    if (!rows.length) throw notFound("media_not_found", "Image not found in this brand");
    try {
      return await readFile(mediaPath(id));
    } catch {
      throw conflict("media_generation_failed", "The source image is unavailable");
    }
  }

  /** Generated bytes pass through exactly the upload decoder and EXIF stripping path. */
  async saveGenerated(
    orgId: string,
    brandId: string,
    bytes: Buffer,
    mimeType: string,
    prompt: string,
    edited: boolean,
  ) {
    return this.upload(orgId, brandId, {
      buffer: bytes,
      originalname: `${edited ? "AI variation" : "AI image"}: ${prompt.replaceAll(/[\\/]/g, " ").slice(0, 160)}`,
      mimetype: mimeType,
    });
  }

  async file(orgId: string, id: string): Promise<Buffer> {
    const asset = await this.requireAsset(orgId, id);
    if (asset.kind !== "image") throw notFound("media_not_found", "Image not found");
    return readFile(mediaPath(id, "image"));
  }

  async fileForStream(orgId: string, id: string) {
    const asset = await this.requireAsset(orgId, id);
    if (asset.kind === "video") await this.requireVideoFile(id, asset.byteSize);
    return { path: mediaPath(id, asset.kind), mimeType: asset.mimeType, kind: asset.kind };
  }

  private async requireVideoFile(id: string, byteSize: number) {
    if (byteSize < 1024 || byteSize > VIDEO_MAX_UPLOAD_BYTES)
      throw notFound("media_not_found", "Video not found");
    try {
      const info = await stat(mediaPath(id, "video"));
      if (!info.isFile() || info.size !== byteSize) throw new Error("Invalid video file size");
    } catch {
      throw notFound("media_not_found", "Video not found");
    }
  }

  async videoForReview(orgId: string, brandId: string, id: string) {
    const rows = await db
      .select({
        id: schema.mediaAssets.id,
        byteSize: schema.mediaAssets.byteSize,
        mimeType: schema.mediaAssets.mimeType,
      })
      .from(schema.mediaAssets)
      .where(
        and(
          eq(schema.mediaAssets.orgId, orgId),
          eq(schema.mediaAssets.brandId, brandId),
          eq(schema.mediaAssets.id, id),
          eq(schema.mediaAssets.kind, "video"),
        ),
      )
      .limit(1);
    if (rows[0]?.mimeType !== "video/mp4") throw notFound("media_not_found", "Video not found");
    await this.requireVideoFile(id, rows[0].byteSize);
    return mediaPath(id, "video");
  }

  async delete(orgId: string, id: string): Promise<void> {
    const asset = await this.requireAsset(orgId, id);
    const attached = await db
      .select({ id: schema.contentItems.id })
      .from(schema.contentItems)
      .where(
        and(
          eq(schema.contentItems.orgId, orgId),
          or(eq(schema.contentItems.coverMediaId, id), eq(schema.contentItems.videoMediaId, id)),
        ),
      )
      .limit(1);
    if (attached.length)
      throw conflict("media_in_use", "Remove this media from its post before deleting it");
    const [inline, feed] = await Promise.all([
      db
        .select({ id: schema.contentImageSlots.id })
        .from(schema.contentImageSlots)
        .where(
          and(eq(schema.contentImageSlots.orgId, orgId), eq(schema.contentImageSlots.mediaId, id)),
        )
        .limit(1),
      db
        .select({ id: schema.feedEntryImages.id })
        .from(schema.feedEntryImages)
        .where(and(eq(schema.feedEntryImages.orgId, orgId), eq(schema.feedEntryImages.mediaId, id)))
        .limit(1),
    ]);
    if (inline.length || feed.length) {
      throw conflict(
        "media_in_use",
        "Remove this image from every post and feed before deleting it",
      );
    }
    let rows: { id: string }[];
    try {
      rows = await db
        .delete(schema.mediaAssets)
        .where(and(eq(schema.mediaAssets.orgId, orgId), eq(schema.mediaAssets.id, id)))
        .returning({ id: schema.mediaAssets.id });
    } catch (error) {
      // A concurrent attachment may land after the prechecks; the foreign key
      // is the final authority and must remain an actionable 409.
      type PgLike = { code?: unknown; cause?: unknown };
      if (
        [error, (error as PgLike | undefined)?.cause].some(
          (candidate) => (candidate as PgLike | undefined)?.code === "23503",
        )
      ) {
        throw conflict(
          "media_in_use",
          "Remove this media from its post or feed before deleting it",
        );
      }
      throw error;
    }
    if (!rows.length) throw notFound("media_not_found", "Image not found");
    await unlink(mediaPath(id, asset.kind)).catch((error: NodeJS.ErrnoException) => {
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
      if (item.status === "archived") {
        throw conflict("content_archived", "Restore this archived post before changing its cover");
      }
      if (!["draft", "rejected", "failed"].includes(item.status)) {
        throw conflict(
          "media_cover_pinned",
          "This post is already approved or published; reject it before changing its cover",
        );
      }
      if (mediaId) {
        const assets = await tx
          .select({
            id: schema.mediaAssets.id,
            kind: schema.mediaAssets.kind,
            byteSize: schema.mediaAssets.byteSize,
          })
          .from(schema.mediaAssets)
          .where(
            and(
              eq(schema.mediaAssets.orgId, orgId),
              eq(schema.mediaAssets.brandId, item.brandId),
              eq(schema.mediaAssets.id, mediaId),
            ),
          )
          .limit(1);
        const asset = assets[0];
        if (asset?.kind !== "image")
          throw notFound("media_not_found", "Image not found in this brand");
        const targets = await tx
          .select({ platform: schema.channels.platform })
          .from(schema.adaptations)
          .innerJoin(schema.channels, eq(schema.channels.id, schema.adaptations.channelId))
          .where(
            and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.contentItemId, itemId)),
          );
        if (
          targets.some((target) => !["telegram", "vk", "max", "bluesky"].includes(target.platform))
        ) {
          throw conflict(
            "content_media_unsupported",
            "Covers currently publish only to Telegram, VK, MAX, and Bluesky; remove other channels from this post",
          );
        }
        if (targets.some((target) => target.platform === "bluesky") && asset.byteSize > 2_000_000) {
          throw conflict(
            "content_media_too_large_for_bluesky",
            "Bluesky covers must be 2 MB or smaller; choose a smaller image",
          );
        }
      }
      await tx
        .update(schema.contentItems)
        .set({ coverMediaId: mediaId, ...(mediaId ? { videoMediaId: null } : {}) })
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, itemId)));
      return { coverMediaId: mediaId };
    });
  }

  async attachVideo(orgId: string, itemId: string, mediaId: string | null) {
    return db.transaction(async (tx) => {
      const [item] = await tx
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
      if (!item) throw notFound("content_not_found", "Post not found");
      if (item.status === "archived") {
        throw conflict("content_archived", "Restore this archived post before changing its video");
      }
      if (!["draft", "rejected", "failed"].includes(item.status)) {
        throw conflict(
          "media_video_pinned",
          "This post is already approved or published; reject it before changing its video",
        );
      }
      if (mediaId) {
        const [asset] = await tx
          .select({ id: schema.mediaAssets.id, kind: schema.mediaAssets.kind })
          .from(schema.mediaAssets)
          .where(
            and(
              eq(schema.mediaAssets.orgId, orgId),
              eq(schema.mediaAssets.brandId, item.brandId),
              eq(schema.mediaAssets.id, mediaId),
            ),
          )
          .limit(1);
        if (asset?.kind !== "video")
          throw notFound("media_not_found", "Video not found in this brand");
        const targets = await tx
          .select({ platform: schema.channels.platform, body: schema.adaptations.body })
          .from(schema.adaptations)
          .innerJoin(schema.channels, eq(schema.channels.id, schema.adaptations.channelId))
          .where(
            and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.contentItemId, itemId)),
          );
        if (targets.some((target) => !["telegram", "vk"].includes(target.platform))) {
          throw conflict(
            "content_media_unsupported",
            "Videos currently publish only to Telegram and VK; remove other channels from this post",
          );
        }
        if (
          targets.some(
            (target) =>
              target.platform === "telegram" &&
              (target.body ?? item.body).length > TELEGRAM_CAPTION_LIMIT,
          )
        ) {
          throw conflict(
            "content_media_caption_too_long",
            "Telegram video captions must be 1024 characters or fewer",
          );
        }
      }
      await tx
        .update(schema.contentItems)
        .set({ videoMediaId: mediaId, ...(mediaId ? { coverMediaId: null } : {}) })
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, itemId)));
      return { videoMediaId: mediaId };
    });
  }

  async requireBrand(orgId: string, brandId: string): Promise<void> {
    const rows = await db
      .select({ id: schema.brands.id })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    if (!rows.length) throw notFound("brand_not_found", "Brand not found");
  }

  private async requireAsset(orgId: string, id: string) {
    const rows = await db
      .select({
        id: schema.mediaAssets.id,
        kind: schema.mediaAssets.kind,
        mimeType: schema.mediaAssets.mimeType,
        byteSize: schema.mediaAssets.byteSize,
      })
      .from(schema.mediaAssets)
      .where(and(eq(schema.mediaAssets.orgId, orgId), eq(schema.mediaAssets.id, id)))
      .limit(1);
    const asset = rows[0];
    if (!asset) throw notFound("media_not_found", "Media not found");
    return asset;
  }
}
