import { schema } from "@pubrick/db";
import { metaContentProblem } from "@pubrick/shared";
import { and, eq, inArray, sql } from "drizzle-orm";
import { conflict } from "../api-error";
import type { db } from "../db";
import { metaApplications } from "../env";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Called by ordinary and batch approval under their existing saved-content locks. */
export async function requireNativeMetaDelivery(
  orgId: string,
  tx: Tx,
  itemId: string,
  channelIds: string[],
): Promise<void> {
  if (!channelIds.length) return;
  const rows = await tx
    .select({
      platform: schema.channels.platform,
      itemBrandId: schema.contentItems.brandId,
      channelBrandId: schema.channels.brandId,
      text: sql<string>`coalesce(${schema.adaptations.body}, ${schema.contentItems.body})`,
      coverId: schema.contentItems.coverMediaId,
      videoId: schema.contentItems.videoMediaId,
      mimeType: schema.mediaAssets.mimeType,
      width: schema.mediaAssets.width,
      height: schema.mediaAssets.height,
      byteSize: schema.mediaAssets.byteSize,
      configured: sql<boolean>`${schema.channels.credentialsEncrypted} is not null and coalesce(${schema.channels.connectionExpiresAt} > clock_timestamp(), false)`,
      applicationId: schema.channels.connectionApplicationId,
      inline: sql<boolean>`exists(select 1 from content_image_slots slots where slots.org_id = ${orgId} and slots.content_item_id = ${schema.contentItems.id})`,
    })
    .from(schema.adaptations)
    .innerJoin(
      schema.contentItems,
      and(
        eq(schema.contentItems.orgId, orgId),
        eq(schema.contentItems.id, schema.adaptations.contentItemId),
      ),
    )
    .innerJoin(
      schema.channels,
      and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, schema.adaptations.channelId)),
    )
    .leftJoin(
      schema.mediaAssets,
      and(
        eq(schema.mediaAssets.orgId, orgId),
        eq(schema.mediaAssets.brandId, schema.contentItems.brandId),
        eq(schema.mediaAssets.id, schema.contentItems.coverMediaId),
      ),
    )
    .where(
      and(
        eq(schema.adaptations.orgId, orgId),
        eq(schema.adaptations.contentItemId, itemId),
        inArray(schema.adaptations.channelId, channelIds),
        inArray(schema.channels.platform, ["threads", "instagram_native", "facebook_page"]),
      ),
    );
  for (const row of rows) {
    if (row.itemBrandId !== row.channelBrandId)
      throw conflict(
        "content_meta_invalid",
        "This native destination does not belong to the post's brand",
      );
    const provider = row.platform as keyof typeof metaApplications;
    if (
      !row.configured ||
      !metaApplications[provider] ||
      row.applicationId !== metaApplications[provider]?.clientId
    )
      throw conflict(
        "meta_reconnect_required",
        "Reconnect the native Meta destination before approval",
      );
    const problem = metaContentProblem(row.platform, row.text, {
      cover: row.coverId
        ? {
            mimeType: row.mimeType ?? "",
            width: row.width,
            height: row.height,
            byteSize: row.byteSize ?? 0,
          }
        : null,
      video: !!row.videoId,
      inlineImages: row.inline,
    });
    if (problem) throw conflict("content_meta_invalid", problem);
  }
}
