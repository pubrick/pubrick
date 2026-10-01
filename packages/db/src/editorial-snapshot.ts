import { createHash } from "node:crypto";
import type { ContentImageAlignment } from "@pubrick/shared";
import { and, asc, eq } from "drizzle-orm";
import type { BillingTransaction } from "./billing-entitlement.js";
import type { createDb } from "./client.js";
import * as schema from "./schema/index.js";

export type EditorialSnapshotReader = BillingTransaction | ReturnType<typeof createDb>["db"];

export type EditorialSnapshot = {
  orgId: string;
  itemId: string;
  brandId: string;
  title: string;
  body: string;
  coverMediaId: string | null;
  videoMediaId: string | null;
  imagesRevision: number;
  images: Array<{
    id: string;
    mediaId: string;
    afterParagraph: number;
    alt: string;
    caption: string | null;
    alignment: ContentImageAlignment;
  }>;
  status: string;
  channels: Array<{
    adaptationId: string;
    channelId: string;
    name: string;
    platform: string;
    body: string;
  }>;
};

/** Stable ordering and explicit fields make every publishable difference invalidate a verdict. */
export function hashEditorialSnapshot(snapshot: EditorialSnapshot): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        title: snapshot.title,
        body: snapshot.body,
        coverMediaId: snapshot.coverMediaId,
        // A changed inline illustration needs a new verdict even when the master
        // text and cover are identical. Older links without slots keep their hash.
        ...(snapshot.imagesRevision > 0 ? { imagesRevision: snapshot.imagesRevision } : {}),
        // Preserve hashes for existing image/text links issued before video support.
        ...(snapshot.videoMediaId ? { videoMediaId: snapshot.videoMediaId } : {}),
        channels: snapshot.channels.map(({ adaptationId, channelId, name, platform, body }) => ({
          adaptationId,
          channelId,
          name,
          platform,
          body,
        })),
      }),
    )
    .digest("hex");
}

export async function readEditorialSnapshot(
  reader: EditorialSnapshotReader,
  orgId: string,
  itemId: string,
): Promise<EditorialSnapshot | null> {
  const [item] = await reader
    .select({
      id: schema.contentItems.id,
      brandId: schema.contentItems.brandId,
      title: schema.contentItems.title,
      body: schema.contentItems.body,
      coverMediaId: schema.contentItems.coverMediaId,
      videoMediaId: schema.contentItems.videoMediaId,
      imagesRevision: schema.contentItems.imagesRevision,
      status: schema.contentItems.status,
    })
    .from(schema.contentItems)
    .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, itemId)))
    .limit(1);
  if (!item) return null;
  const images = await reader
    .select({
      id: schema.contentImageSlots.id,
      mediaId: schema.contentImageSlots.mediaId,
      afterParagraph: schema.contentImageSlots.afterParagraph,
      alt: schema.contentImageSlots.alt,
      caption: schema.contentImageSlots.caption,
      alignment: schema.contentImageSlots.alignment,
    })
    .from(schema.contentImageSlots)
    .where(
      and(
        eq(schema.contentImageSlots.orgId, orgId),
        eq(schema.contentImageSlots.contentItemId, itemId),
      ),
    )
    .orderBy(asc(schema.contentImageSlots.afterParagraph));
  const channels = await reader
    .select({
      adaptationId: schema.adaptations.id,
      channelId: schema.adaptations.channelId,
      name: schema.channels.name,
      platform: schema.channels.platform,
      body: schema.adaptations.body,
    })
    .from(schema.adaptations)
    .innerJoin(
      schema.channels,
      and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, schema.adaptations.channelId)),
    )
    .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.contentItemId, itemId)))
    .orderBy(asc(schema.adaptations.id));
  return {
    orgId,
    itemId,
    brandId: item.brandId,
    title: item.title ?? "",
    body: item.body,
    coverMediaId: item.coverMediaId,
    videoMediaId: item.videoMediaId,
    imagesRevision: item.imagesRevision ?? 0,
    images,
    status: item.status,
    channels: channels.map((row) => ({ ...row, body: row.body ?? item.body })),
  };
}
