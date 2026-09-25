import { z } from "zod";
import { MAX_BODY_LENGTH } from "./content.js";

export const MAX_CONTENT_IMAGES = 5;

/** `afterParagraph: 0` places the image after the first nonempty paragraph. */
export const contentImageInputSchema = z.strictObject({
  mediaId: z.uuid(),
  afterParagraph: z.number().int().min(0),
  alt: z.string().trim().min(1).max(300),
  caption: z.string().trim().max(500).optional(),
});
export type ContentImageInput = z.infer<typeof contentImageInputSchema>;

export const contentImagesReplaceSchema = z
  .strictObject({
    images: z.array(contentImageInputSchema).max(MAX_CONTENT_IMAGES),
    expectedRevision: z.number().int().nonnegative(),
    /** Explicit acknowledgment of all retained generated illustrations. */
    reviewGeneratedImages: z.literal(true).optional(),
  })
  .superRefine(({ images }, context) => {
    const seen = new Set<number>();
    for (const [index, image] of images.entries()) {
      if (seen.has(image.afterParagraph)) {
        context.addIssue({
          code: "custom",
          path: ["images", index, "afterParagraph"],
          message: "Each paragraph can have only one image",
        });
      }
      seen.add(image.afterParagraph);
    }
  });
export type ContentImagesReplace = z.infer<typeof contentImagesReplaceSchema>;

/** The server derives the prompt and source from the selected slot. */
export const contentImageRegenerateSchema = z.strictObject({
  expectedRevision: z.number().int().nonnegative(),
  expectedBody: z.string().max(MAX_BODY_LENGTH),
});
export type ContentImageRegenerate = z.infer<typeof contentImageRegenerateSchema>;

export const contentImageDtoSchema = contentImageInputSchema.extend({
  id: z.uuid(),
  caption: z.string().nullable(),
  needsReview: z.boolean(),
});
export type ContentImageDto = z.infer<typeof contentImageDtoSchema>;

export const contentImagesStateSchema = z.strictObject({
  images: z.array(contentImageDtoSchema),
  revision: z.number().int().nonnegative(),
});
export type ContentImagesState = z.infer<typeof contentImagesStateSchema>;
