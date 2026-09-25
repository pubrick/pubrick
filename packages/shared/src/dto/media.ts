import { z } from "zod";

/** Both manual and draft-run image calls share one nominal hourly budget. */
export const IMAGE_CALL_STEPS = [
  "image_generate",
  "image_regenerate",
  "cover",
  "inline_image",
] as const;
export const MAX_IMAGE_CALLS_PER_HOUR = 12;
/** Channels for which the existing publish gate accepts an image cover. */
export const COVER_SUPPORTED_PLATFORMS = ["telegram", "vk", "max", "bluesky"] as const;

/** The safe, public metadata returned by the brand-scoped media library. */
const mediaCommon = {
  id: z.uuid(),
  brandId: z.uuid(),
  name: z.string(),
  byteSize: z.number().int().positive(),
  createdAt: z.string(),
};

export const mediaAssetDtoSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...mediaCommon,
    kind: z.literal("image"),
    mimeType: z.literal("image/jpeg"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  z.strictObject({
    ...mediaCommon,
    kind: z.literal("video"),
    mimeType: z.literal("video/mp4"),
    width: z.null(),
    height: z.null(),
  }),
]);
export type MediaAssetDto = z.infer<typeof mediaAssetDtoSchema>;

export const mediaCoverUpdateSchema = z.strictObject({ mediaId: z.uuid().nullable() });
export type MediaCoverUpdate = z.infer<typeof mediaCoverUpdateSchema>;

export const mediaVideoUpdateSchema = z.strictObject({ mediaId: z.uuid().nullable() });
export type MediaVideoUpdate = z.infer<typeof mediaVideoUpdateSchema>;

/** A deliberate, single image call. Editing preserves the source as another asset. */
export const mediaGenerateSchema = z.strictObject({
  brandId: z.uuid(),
  prompt: z.string().trim().min(8).max(2000),
  sourceMediaId: z.uuid().optional(),
});
export type MediaGenerate = z.infer<typeof mediaGenerateSchema>;

/** A paid cover call may finish after someone else has changed the draft. */
export const mediaCoverRegenerateSchema = z.strictObject({
  prompt: z.string().trim().min(8).max(2000),
  expectedCoverMediaId: z.uuid().nullable(),
});
export type MediaCoverRegenerate = z.infer<typeof mediaCoverRegenerateSchema>;

export const mediaCoverRegenerateResultSchema = z.strictObject({
  asset: mediaAssetDtoSchema,
  attached: z.boolean(),
  /** Set when the paid asset remains in the library for manual selection. */
  reason: z.string().optional(),
});
export type MediaCoverRegenerateResult = z.infer<typeof mediaCoverRegenerateResultSchema>;
