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
    expectedTitle: z
      .string()
      .max(300)
      .refine((value) => !hasNulByte(value), NO_NUL_BYTE_MESSAGE)
      .nullable(),
    instruction: instruction.optional(),
    noteId: z.string().uuid().optional(),
    expectedImagesRevision: z.number().int().nonnegative().optional(),
    expectedCoverMediaId: z.string().uuid().nullable().optional(),
    regenerateImages: z
      .strictObject({ cover: z.boolean(), inlineSlotIds: z.array(z.string().uuid()).max(5) })
      .optional(),
  })
  .refine((value) => Number(Boolean(value.instruction)) + Number(Boolean(value.noteId)) <= 1, {
    message: "Provide at most one instruction or saved editorial note",
  })
  .refine(
    (value) =>
      Boolean(
        value.instruction ||
          value.noteId ||
          value.regenerateImages?.cover ||
          value.regenerateImages?.inlineSlotIds.length,
      ),
    {
      message: "Provide an instruction, saved note, or selected image",
    },
  )
  .refine(
    (value) =>
      !value.regenerateImages ||
      (value.expectedImagesRevision !== undefined && value.expectedCoverMediaId !== undefined),
    {
      message: "Image selections require a cover and image revision snapshot",
    },
  );
export type DraftRevisionRequest = z.infer<typeof draftRevisionRequestSchema>;

export const draftRevisionImagePlanSchema = z.strictObject({
  sourceImagesRevision: z.number().int().nonnegative(),
  sourceCoverMediaId: z.string().uuid().nullable(),
  textModelUsed: z.boolean(),
  inFlight: z
    .strictObject({
      token: z.string().uuid(),
      startedAt: z.string().datetime(),
      selection: z.number().int().nonnegative(),
    })
    .nullable(),
  selections: z
    .array(
      z.strictObject({
        kind: z.enum(["cover", "inline"]),
        slotId: z.string().uuid().nullable(),
        sourceMediaId: z.string().uuid(),
        afterParagraph: z.number().int().nonnegative().nullable(),
        generatedMediaId: z.string().uuid().nullable(),
      }),
    )
    .max(6),
});
export type DraftRevisionImagePlan = z.infer<typeof draftRevisionImagePlanSchema>;

export const draftRevisionProposalSchema = z.object({
  id: z.string().uuid(),
  sourceBody: z.string(),
  sourceTitle: z.string().nullable(),
  instruction: z.string(),
  proposal: z.string(),
  proposedTitle: z.string().nullable(),
  reason: z.string(),
  imagePlan: draftRevisionImagePlanSchema.nullable(),
});
export type DraftRevisionProposal = z.infer<typeof draftRevisionProposalSchema>;
