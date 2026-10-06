import { createHash } from "node:crypto";
import path from "node:path";
import { Injectable } from "@nestjs/common";
import { readBoundedFile, schema } from "@pubrick/db";
import {
  type ApprovedJpegIdentity,
  approvedJpegIdentitySchema,
  META_MEDIA_ACCESS_TTL_MS,
  PermanentError,
  sealMetaMediaAccess,
} from "@pubrick/shared";
import { and, eq, sql } from "drizzle-orm";
import sharp from "sharp";
import { db } from "../db";
import { env } from "../env";
import type { StagedAssetProvider, StageLease } from "./staged-publication.contract";

/** Reads one immutable normalized file, never an arbitrary path or URL. */
@Injectable()
export class StagedAssets implements StagedAssetProvider {
  async snapshot(orgId: string, brandId: string, mediaId: string): Promise<ApprovedJpegIdentity> {
    const [asset] = await db
      .select({
        id: schema.mediaAssets.id,
        kind: schema.mediaAssets.kind,
        mimeType: schema.mediaAssets.mimeType,
        width: schema.mediaAssets.width,
        height: schema.mediaAssets.height,
        byteSize: schema.mediaAssets.byteSize,
      })
      .from(schema.mediaAssets)
      .where(
        and(
          eq(schema.mediaAssets.orgId, orgId),
          eq(schema.mediaAssets.brandId, brandId),
          eq(schema.mediaAssets.id, mediaId),
        ),
      );
    if (
      asset?.kind !== "image" ||
      asset.mimeType !== "image/jpeg" ||
      asset.byteSize > 8 * 1024 * 1024
    )
      throw new PermanentError("Instagram requires one approved JPEG of at most 8 MB");
    try {
      const bytes = await readBoundedFile(
        path.join(env.MEDIA_STORAGE_DIR, `${asset.id}.jpg`),
        asset.byteSize,
        8 * 1024 * 1024,
      );
      const decoded = await sharp(bytes, {
        limitInputPixels: 40_000_000,
        failOn: "error",
      }).metadata();
      if (
        decoded.format !== "jpeg" ||
        decoded.width !== asset.width ||
        decoded.height !== asset.height ||
        (decoded.space !== "srgb" && decoded.space !== "rgb")
      )
        throw new Error();
      return approvedJpegIdentitySchema.parse({
        mediaId: asset.id,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mimeType: "image/jpeg",
        width: decoded.width,
        height: decoded.height,
        byteSize: bytes.length,
      });
    } catch {
      throw new PermanentError("The approved Instagram JPEG changed or is unavailable");
    }
  }

  async capability(orgId: string, stage: StageLease) {
    const origin = new URL(env.WEB_ORIGIN);
    if (origin.protocol !== "https:" || origin.origin !== env.WEB_ORIGIN.replace(/\/$/, ""))
      throw new PermanentError(
        "Native Instagram needs the public HTTPS origin configured on this server",
      );
    if (stage.identity.orgId !== orgId || !stage.input.image)
      throw new PermanentError("The approved image does not match this delivery");
    const [clock] = await db
      .select({ now: sql<Date>`clock_timestamp()` })
      .from(schema.metaPublicationStages)
      .where(
        and(
          eq(schema.metaPublicationStages.orgId, orgId),
          eq(schema.metaPublicationStages.id, stage.id),
          eq(schema.metaPublicationStages.leaseToken, stage.leaseToken),
          eq(schema.metaPublicationStages.phase, "preparation_intent"),
          sql`${schema.metaPublicationStages.leaseUntil} > clock_timestamp()`,
          sql`${schema.metaPublicationStages.preparationDeadline} > clock_timestamp()`,
        ),
      );
    if (!clock) throw new PermanentError("The approved image preparation expired");
    const now = new Date(clock.now).getTime();
    const expiresAt = new Date(
      Math.min(stage.deadline.getTime(), now + META_MEDIA_ACCESS_TTL_MS),
    ).toISOString();
    if (Date.parse(expiresAt) - now < 30_000)
      throw new PermanentError("The approved image preparation expired");
    const token = sealMetaMediaAccess(
      {
        purpose: "meta_preparation",
        stageId: stage.id,
        identity: stage.identity,
        image: stage.input.image,
        issuedAt: new Date(now).toISOString(),
        expiresAt,
      },
      env.APP_ENCRYPTION_KEY,
    );
    return {
      url: `${origin.origin}/api/media/meta/${encodeURIComponent(orgId)}/${token}`,
      expiresAt,
      orgId,
      adaptationId: stage.identity.adaptationId,
      attempt: stage.identity.attempt,
      mediaId: stage.input.image.mediaId,
      sha256: stage.input.image.sha256,
      purpose: "meta_preparation" as const,
    };
  }
}
