import { Injectable } from "@nestjs/common";
import { schema } from "@pubrick/db";
import type { ContentImageRegenerate, ContentImagesReplace } from "@pubrick/shared";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { badRequest, conflict, notFound } from "../api-error";
import { db } from "../db";
import { MediaImageService } from "../media/media-image.service";

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
  constructor(private readonly imageGeneration: MediaImageService) {}

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
      this.assertEditable(item.status);
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

  /**
   * The model call runs between two short transactions. A paid image is saved
   * in the library first; if an editor changes the draft while Gemini runs, it
   * stays there for manual placement and cannot overwrite that editor's work.
   */
  async regenerate(
    orgId: string,
    contentItemId: string,
    slotId: string,
    data: ContentImageRegenerate,
  ) {
    const source = await db.transaction(async (tx) => {
      const [organization] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, orgId))
        .limit(1)
        .for("key share");
      if (!organization) throw notFound("content_not_found", "Content item not found");
      const [item] = await tx
        .select({
          brandId: schema.contentItems.brandId,
          body: schema.contentItems.body,
          status: schema.contentItems.status,
          revision: schema.contentItems.imagesRevision,
        })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, contentItemId)))
        .limit(1)
        .for("share");
      if (!item) throw notFound("content_not_found", "Content item not found");
      this.assertEditable(item.status);
      if ((item.revision ?? 0) !== data.expectedRevision) this.changed();
      const [slot] = await tx
        .select({
          mediaId: schema.contentImageSlots.mediaId,
          afterParagraph: schema.contentImageSlots.afterParagraph,
        })
        .from(schema.contentImageSlots)
        .where(
          and(
            eq(schema.contentImageSlots.orgId, orgId),
            eq(schema.contentImageSlots.contentItemId, contentItemId),
            eq(schema.contentImageSlots.id, slotId),
          ),
        )
        .limit(1);
      if (!slot) throw notFound("content_image_not_found", "Image slot not found");
      const passage = item.body.split(/\n\s*\n/).filter((part) => part.trim())[slot.afterParagraph];
      if (!passage) this.changed();
      const prompt =
        "Create one 1K editorial illustration by varying the provided image. " +
        "Depict the passage below while keeping a visual connection to the source. " +
        "No text, lettering, logos, or watermarks. " +
        `Article context:\n<draft>\n${item.body.slice(0, 800)}\n</draft>\n` +
        `Passage to illustrate:\n<passage>\n${passage.slice(0, 800)}\n</passage>`;
      return { ...item, ...slot, prompt };
    });

    const image = await this.imageGeneration.generate(orgId, {
      brandId: source.brandId,
      sourceMediaId: source.mediaId,
      prompt: source.prompt,
    });
    if (!image) throw conflict("media_generation_failed", "Generated image was not saved");

    return db.transaction(async (tx) => {
      // Match inline replacement's order: organization, item, then media.
      const [organization] = await tx
        .select({ id: schema.organization.id })
        .from(schema.organization)
        .where(eq(schema.organization.id, orgId))
        .limit(1)
        .for("key share");
      if (!organization) this.changed();
      const [item] = await tx
        .select({
          brandId: schema.contentItems.brandId,
          body: schema.contentItems.body,
          status: schema.contentItems.status,
          revision: schema.contentItems.imagesRevision,
        })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, contentItemId)))
        .limit(1)
        .for("update");
      if (!item) this.changed();
      this.assertEditable(item.status);
      if (
        (item.revision ?? 0) !== data.expectedRevision ||
        item.body !== source.body ||
        item.brandId !== source.brandId
      ) {
        this.changed();
      }
      const [slot] = await tx
        .select({
          mediaId: schema.contentImageSlots.mediaId,
          afterParagraph: schema.contentImageSlots.afterParagraph,
        })
        .from(schema.contentImageSlots)
        .where(
          and(
            eq(schema.contentImageSlots.orgId, orgId),
            eq(schema.contentImageSlots.contentItemId, contentItemId),
            eq(schema.contentImageSlots.id, slotId),
          ),
        )
        .limit(1);
      if (
        !slot ||
        slot.mediaId !== source.mediaId ||
        slot.afterParagraph !== source.afterParagraph
      ) {
        this.changed();
      }
      const [asset] = await tx
        .select({ id: schema.mediaAssets.id })
        .from(schema.mediaAssets)
        .where(
          and(
            eq(schema.mediaAssets.orgId, orgId),
            eq(schema.mediaAssets.brandId, item.brandId),
            eq(schema.mediaAssets.kind, "image"),
            eq(schema.mediaAssets.id, image.id),
          ),
        )
        .limit(1)
        .for("key share");
      if (!asset) this.changed();
      await tx
        .update(schema.contentImageSlots)
        .set({
          mediaId: image.id,
          alt: `Generated illustration for paragraph ${slot.afterParagraph + 1}; review before publishing`,
          caption: null,
          needsReview: true,
        })
        .where(eq(schema.contentImageSlots.id, slotId));
      const revision = data.expectedRevision + 1;
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

  private assertEditable(status: string): void {
    if (status === "archived") {
      throw conflict("content_archived", "Restore this archived post before editing its images");
    }
    if (!["draft", "rejected", "failed"].includes(status)) {
      throw conflict("content_media_pinned", "Images are pinned in this post status");
    }
  }

  private changed(): never {
    throw conflict(
      "content_images_changed",
      "Images changed in another editor; reload before saving",
    );
  }
}
