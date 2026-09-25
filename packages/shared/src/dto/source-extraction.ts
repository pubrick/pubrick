import { z } from "zod";
import { MAX_SOURCE_TEXT_LENGTH, MAX_SOURCE_URL_LENGTH } from "./runs.js";

/** One explicit, authenticated preview fetch. Generation never dereferences this URL. */
export const sourceExtractionRequestSchema = z.object({
  url: z
    .url({ protocol: /^https?$/ })
    .max(MAX_SOURCE_URL_LENGTH)
    .refine((value) => {
      try {
        const parsed = new URL(value);
        return parsed.username === "" && parsed.password === "";
      } catch {
        return false;
      }
    }, "A source URL cannot contain credentials"),
});
export type SourceExtractionRequest = z.infer<typeof sourceExtractionRequestSchema>;

export const sourceExtractionResponseSchema = z.object({
  kind: z.enum(["article", "video"]).optional(),
  title: z.string().max(500),
  material: z.string().min(1).max(MAX_SOURCE_TEXT_LENGTH),
  truncated: z.boolean(),
});
export type SourceExtractionResponse = z.infer<typeof sourceExtractionResponseSchema>;
