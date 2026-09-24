import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import type { ContentImagesReplace } from "@pubrick/shared";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { badRequest, conflict, notFound } from "../api-error";
import { db } from "../db";

const COLUMNS = {
  id: schema.contentImageSlots.id,
  mediaId: schema.contentImageSlots.mediaId,
  afterParagraph: schema.contentImageSlots.afterParagraph,
  alt: schema.contentImageSlots.alt,
  caption: schema.contentImageSlots.caption,
  needsReview: schema.contentImageSlots.needsReview,
};

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Refuse a body edit that would silently hide an attached image. */
export async function assertImagesFitBody(
  tx: Tx,
  orgId: string,
  contentItemId: string,
  body: string,
) {
  const paragraphCount = body.split(/\n\s*\n/).filter((part) => part.trim()).length;
  const [lastSlot] = await tx
    .select({ afterParagraph: schema.contentImageSlots.afterParagraph })
    .from(schema.contentImageSlots)
    .where(
      and(
        eq(schema.contentImageSlots.orgId, orgId),
        eq(schema.contentImageSlots.contentItemId, contentItemId),
      ),
    )
    .orderBy(desc(schema.contentImageSlots.afterParagraph))
    .limit(1);
  if (lastSlot && lastSlot.afterParagraph >= paragraphCount) {
    throw conflict(
      "content_image_body_conflict",
      "Move or remove inline images before shortening this post's body",
    );
  }
}

/** The editor keeps the body plain text and stores image placements separately. */
@Injectable()
export class ContentImagesRepository {
  async list(orgId: string, contentItemId: string) {
    return db.transaction(async (tx) => {
      // Keep the revision and slot set from one committed state. A concurrent
      // replacement holds FOR UPDATE on this row until its slots are written.
      const [item] = await tx
        .select({ revision: schema.contentItems.imagesRevision })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, contentItemId)))
        .limit(1)
        .for("share");
      if (!item) throw notFound("content_not_found", "Content item not found");
      const images = await tx
        .select(COLUMNS)
        .from(schema.contentImageSlots)
        .where(
          and(
            eq(schema.contentImageSlots.orgId, orgId),
            eq(schema.contentImageSlots.contentItemId, contentItemId),
          ),
        )
        .orderBy(asc(schema.contentImageSlots.afterParagraph), asc(schema.contentImageSlots.id));
      return { images, revision: item.revision ?? 0 };
    });
  }

  async replace(orgId: string, contentItemId: string, data: ContentImagesReplace) {
    return db.transaction(async (tx) => {
      // An organization delete starts at the org row before cascading into
      // items. Slot inserts reference that row, so take its key-share lock
      // before the item's lock rather than in the opposite order at INSERT.
      const [organization] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, orgId))
        .limit(1)
        .for("key share");
      if (!organization) throw notFound("content_not_found", "Content item not found");
      // Serialize with body edits and approval on the parent item. Media
      // locks follow the item lock; deletion never takes an item row lock.
      const [item] = await tx
        .select({
          id: schema.contentItems.id,
          brandId: schema.contentItems.brandId,
          body: schema.contentItems.body,
          status: schema.contentItems.status,
          imagesRevision: schema.contentItems.imagesRevision,
        })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, contentItemId)))
        .limit(1)
        .for("update");
      if (!item) throw notFound("content_not_found", "Content item not found");
      if (item.status === "archived") {
        throw conflict("content_archived", "Restore this archived post before editing its images");
      }
      if (!["draft", "rejected", "failed"].includes(item.status)) {
        throw conflict("content_media_pinned", "Images are pinned in this post status");
      }
      const currentRevision = item.imagesRevision ?? 0;
      if (currentRevision !== data.expectedRevision) {
        throw conflict(
          "content_images_changed",
          "Images changed in another editor; reload before saving",
        );
      }

      const paragraphCount = item.body.split(/\n\s*\n/).filter((part) => part.trim()).length;
      if (data.images.some((image) => image.afterParagraph >= paragraphCount)) {
        throw badRequest(
          "content_image_position_invalid",
          "An image position exceeds the post body",
        );
      }

      const mediaIds = [...new Set(data.images.map((image) => image.mediaId))].sort();
      if (mediaIds.length) {
        const assets = await tx
          .select({ id: schema.mediaAssets.id })
          .from(schema.mediaAssets)
          .where(
            and(
              eq(schema.mediaAssets.orgId, orgId),
              eq(schema.mediaAssets.brandId, item.brandId),
              eq(schema.mediaAssets.kind, "image"),
              inArray(schema.mediaAssets.id, mediaIds),
            ),
          )
          .orderBy(asc(schema.mediaAssets.id))
          .for("key share");
        if (assets.length !== mediaIds.length) {
          throw notFound("media_not_found", "Image not found in this brand");
        }
      }

      const existing = await tx
        .select({
          mediaId: schema.contentImageSlots.mediaId,
          afterParagraph: schema.contentImageSlots.afterParagraph,
          needsReview: schema.contentImageSlots.needsReview,
        })
        .from(schema.contentImageSlots)
        .where(
          and(
            eq(schema.contentImageSlots.orgId, orgId),
            eq(schema.contentImageSlots.contentItemId, contentItemId),
          ),
        );
      const pending = new Set(
        existing.filter((slot) => slot.needsReview).map((slot) => slot.mediaId),
      );
      await tx
        .delete(schema.contentImageSlots)
        .where(
          and(
            eq(schema.contentImageSlots.orgId, orgId),
            eq(schema.contentImageSlots.contentItemId, contentItemId),
          ),
        );
      if (data.images.length) {
        await tx.insert(schema.contentImageSlots).values(
          data.images.map((image) => ({
            orgId,
            brandId: item.brandId,
            contentItemId,
            mediaId: image.mediaId,
            afterParagraph: image.afterParagraph,
            alt: image.alt,
            caption: image.caption || null,
            needsReview: !data.reviewGeneratedImages && pending.has(image.mediaId),
          })),
        );
      }
      const revision = currentRevision + 1;
      await tx
        .update(schema.contentItems)
        .set({ imagesRevision: revision })
        .where(
          and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, contentItemId)),
        );
      const images = await tx
        .select(COLUMNS)
        .from(schema.contentImageSlots)
        .where(
          and(
            eq(schema.contentImageSlots.orgId, orgId),
            eq(schema.contentImageSlots.contentItemId, contentItemId),
          ),
        )
        .orderBy(asc(schema.contentImageSlots.afterParagraph), asc(schema.contentImageSlots.id));
      return { images, revision };
    });
  }
}
