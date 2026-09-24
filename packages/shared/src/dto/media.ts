import { z } from "zod";

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
