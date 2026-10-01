import { z } from "zod";
import { CONTENT_ORIGINS } from "./content-origins.js";
import { hasNulByte, NO_NUL_BYTE_MESSAGE } from "./text.js";

// Independent of content/run DTOs so those projections may import this without a cycle.
const revisionSchema = z.number().int().min(0);
const savedTitleSchema = z
  .string()
  .refine((value) => !hasNulByte(value), NO_NUL_BYTE_MESSAGE)
  .nullable();

/** Permission-safe projection: unavailable and erased sources carry no title or link identity. */
export const contentReuseAttributionSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("available"),
    sourceContentId: z.uuid(),
    sourceRevision: revisionSchema,
    title: savedTitleSchema,
    origin: z.enum(CONTENT_ORIGINS),
  }),
  z.strictObject({ state: z.literal("unavailable"), sourceRevision: revisionSchema }),
  z.strictObject({ state: z.literal("redacted"), sourceRevision: revisionSchema }),
]);
export type ContentReuseAttribution = z.infer<typeof contentReuseAttributionSchema>;
