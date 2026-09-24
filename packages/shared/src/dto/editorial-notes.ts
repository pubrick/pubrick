import { z } from "zod";
import { normalizeNewlines } from "../provenance.js";
import { MAX_BODY_LENGTH } from "./content.js";
import { hasNulByte, NO_NUL_BYTE_MESSAGE } from "./text.js";

export const editorialNoteCreateSchema = z.strictObject({
  expectedBody: z.string().transform(normalizeNewlines).pipe(z.string().max(MAX_BODY_LENGTH)),
  note: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .refine((value) => !hasNulByte(value), NO_NUL_BYTE_MESSAGE),
});
export type EditorialNoteCreate = z.infer<typeof editorialNoteCreateSchema>;

export const editorialNoteDtoSchema = z.strictObject({
  id: z.string().uuid(),
  note: z.string(),
  /** True only while the master body's saved text matches the submitted snapshot. */
  current: z.boolean(),
  createdBy: z.string().nullable(),
  authorName: z.string().nullable(),
  createdAt: z.string(),
});
export type EditorialNoteDto = z.infer<typeof editorialNoteDtoSchema>;

export const editorialNoteListQuerySchema = z.object({ cursor: z.string().uuid().optional() });
export type EditorialNoteListQuery = z.infer<typeof editorialNoteListQuerySchema>;
