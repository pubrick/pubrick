import { z } from "zod";

/** The safe, public metadata returned by the brand-scoped media library. */
export const mediaAssetDtoSchema = z.strictObject({
  id: z.uuid(),
  brandId: z.uuid(),
  name: z.string(),
  mimeType: z.literal("image/jpeg"),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  byteSize: z.number().int().positive(),
  createdAt: z.string(),
});
export type MediaAssetDto = z.infer<typeof mediaAssetDtoSchema>;

export const mediaCoverUpdateSchema = z.strictObject({ mediaId: z.uuid().nullable() });
export type MediaCoverUpdate = z.infer<typeof mediaCoverUpdateSchema>;

/** A deliberate, single image call. Editing preserves the source as another asset. */
export const mediaGenerateSchema = z.strictObject({
  brandId: z.uuid(),
  prompt: z.string().trim().min(8).max(2000),
  sourceMediaId: z.uuid().optional(),
});
export type MediaGenerate = z.infer<typeof mediaGenerateSchema>;
