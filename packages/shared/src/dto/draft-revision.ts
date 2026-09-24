import { z } from "zod";
import { normalizeNewlines } from "../provenance.js";
import { MAX_BODY_LENGTH } from "./content.js";
import { hasNulByte, NO_NUL_BYTE_MESSAGE } from "./text.js";

const instruction = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((value) => !hasNulByte(value), NO_NUL_BYTE_MESSAGE);

export const draftRevisionRequestSchema = z
  .strictObject({
    expectedBody: z
      .string()
      .transform(normalizeNewlines)
      .pipe(z.string().min(1).max(MAX_BODY_LENGTH)),
    instruction: instruction.optional(),
    noteId: z.string().uuid().optional(),
  })
  .refine((value) => Number(Boolean(value.instruction)) + Number(Boolean(value.noteId)) === 1, {
    message: "Provide either an instruction or one saved editorial note",
  });
export type DraftRevisionRequest = z.infer<typeof draftRevisionRequestSchema>;

export const draftRevisionProposalSchema = z.object({
  id: z.string().uuid(),
  sourceBody: z.string(),
  instruction: z.string(),
  proposal: z.string(),
  reason: z.string(),
});
export type DraftRevisionProposal = z.infer<typeof draftRevisionProposalSchema>;
