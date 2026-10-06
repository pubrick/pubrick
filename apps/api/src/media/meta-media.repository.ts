import { createHash } from "node:crypto";
import { Injectable, NotFoundException } from "@nestjs/common";
import { readBoundedFile, schema } from "@pubrick/db";
import { type MetaMediaAccess, openMetaMediaAccess } from "@pubrick/shared";
import { and, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { db } from "../db";
import { env, metaApplications } from "../env";
import { mediaPath } from "./media.repository";

/** Public access is limited to the worker's exact reviewed, current preparation claim. */
@Injectable()
export class MetaMediaRepository {
  private async authorized(orgId: string, claim: MetaMediaAccess) {
    const stage = schema.metaPublicationStages;
    const [row] = await db
      .select({ image: stage.frozenInput, id: stage.id })
      .from(stage)
      .innerJoin(
        schema.adaptations,
        and(
          eq(schema.adaptations.orgId, orgId),
          eq(schema.adaptations.id, stage.adaptationId),
          eq(schema.adaptations.contentItemId, stage.contentItemId),
          eq(schema.adaptations.channelId, stage.channelId),
        ),
      )
      .innerJoin(
        schema.contentItems,
        and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, stage.contentItemId)),
      )
      .innerJoin(
        schema.channels,
        and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, stage.channelId)),
      )
      .innerJoin(
        schema.mediaAssets,
        and(
          eq(schema.mediaAssets.orgId, orgId),
          eq(schema.mediaAssets.brandId, stage.brandId),
          eq(schema.mediaAssets.id, claim.image.mediaId),
        ),
      )
      .where(
        and(
          eq(stage.orgId, orgId),
          eq(stage.id, claim.stageId),
          eq(stage.platform, "instagram_native"),
          eq(stage.brandId, claim.identity.brandId),
          eq(stage.adaptationId, claim.identity.adaptationId),
          eq(stage.channelId, claim.identity.channelId),
          eq(stage.attempt, claim.identity.attempt),
          eq(stage.inputHash, claim.identity.inputHash),
          eq(stage.target, claim.identity.target),
          eq(stage.credentialGeneration, claim.identity.credentialGeneration),
          inArray(stage.phase, ["preparation_intent", "waiting"]),
          sql`${stage.preparationDeadline} > clock_timestamp()`,
          sql`${new Date(claim.expiresAt)}::timestamptz > clock_timestamp()`,
          eq(schema.adaptations.status, "publishing"),
          eq(schema.adaptations.attemptCount, claim.identity.attempt),
          eq(schema.contentItems.brandId, claim.identity.brandId),
          notInArray(schema.contentItems.status, ["rejected", "archived"]),
          sql`coalesce(${schema.adaptations.body}, ${schema.contentItems.body}) = ${stage.frozenInput}->>'text'`,
          eq(schema.contentItems.coverMediaId, claim.image.mediaId),
          eq(schema.channels.brandId, claim.identity.brandId),
          eq(schema.channels.platform, "instagram_native"),
          eq(schema.channels.connectionGeneration, claim.identity.credentialGeneration),
          eq(schema.channels.connectionTarget, claim.identity.target),
          eq(
            schema.channels.connectionApplicationId,
            metaApplications.instagram_native?.clientId ?? "",
          ),
          isNotNull(schema.channels.credentialsEncrypted),
          sql`${schema.channels.connectionExpiresAt} > clock_timestamp()`,
          eq(schema.mediaAssets.kind, "image"),
          eq(schema.mediaAssets.mimeType, "image/jpeg"),
          eq(schema.mediaAssets.width, claim.image.width),
          eq(schema.mediaAssets.height, claim.image.height),
          eq(schema.mediaAssets.byteSize, claim.image.byteSize),
        ),
      );
    const image = row?.image.image;
    return (
      !!image &&
      image.mediaId === claim.image.mediaId &&
      image.sha256 === claim.image.sha256 &&
      image.byteSize === claim.image.byteSize &&
      image.width === claim.image.width &&
      image.height === claim.image.height
    );
  }

  async file(orgId: string, token: string): Promise<Buffer> {
    try {
      const [clock] = await db
        .select({ now: sql<Date>`clock_timestamp()` })
        .from(schema.organization)
        .where(eq(schema.organization.id, orgId))
        .limit(1);
      if (!clock) throw new Error();
      const claim = openMetaMediaAccess(
        orgId,
        token,
        env.APP_ENCRYPTION_KEY,
        new Date(clock.now).getTime(),
      );
      if (claim.image.byteSize > 8_000_000 || !(await this.authorized(orgId, claim)))
        throw new Error();
      const bytes = await readBoundedFile(
        mediaPath(claim.image.mediaId),
        claim.image.byteSize,
        8_000_000,
      );
      if (
        bytes.length !== claim.image.byteSize ||
        createHash("sha256").update(bytes).digest("hex") !== claim.image.sha256 ||
        !(await this.authorized(orgId, claim))
      )
        throw new Error();
      return bytes;
    } catch {
      // Every refusal is opaque; tokens, claims, SQL parameters and file paths never enter the HTTP error.
      throw new NotFoundException("Approved image is unavailable");
    }
  }
}
