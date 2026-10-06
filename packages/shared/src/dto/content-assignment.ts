import { z } from "zod";
import { hasNulByte, NO_NUL_BYTE_MESSAGE } from "./text.js";

export const CONTENT_ASSIGNMENT_FILTERS = ["all", "mine", "unassigned"] as const;
export type ContentAssignmentFilter = (typeof CONTENT_ASSIGNMENT_FILTERS)[number];
export const contentAssignmentFilterSchema = z.enum(CONTENT_ASSIGNMENT_FILTERS);

const memberIdSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((id) => !hasNulByte(id), NO_NUL_BYTE_MESSAGE);

/** Assignment revisions are independent of text, media and delivery revisions. */
export const contentAssignmentUpdateSchema = z.strictObject({
  memberId: memberIdSchema.nullable(),
  expectedRevision: z.number().int().min(0).max(2_147_483_646),
});
export type ContentAssignmentUpdate = z.infer<typeof contentAssignmentUpdateSchema>;

export const contentAssignmentMemberSchema = z.strictObject({
  memberId: memberIdSchema,
  userId: z.string(),
  name: z.string(),
});
export type ContentAssignmentMember = z.infer<typeof contentAssignmentMemberSchema>;

export const contentAssignmentSummarySchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  assignee: contentAssignmentMemberSchema.extend({ eligible: z.boolean() }).nullable(),
});
export type ContentAssignmentSummary = z.infer<typeof contentAssignmentSummarySchema>;

export const contentAssignmentHistoryQuerySchema = z.strictObject({
  cursor: z.string().uuid().optional(),
});
export type ContentAssignmentHistoryQuery = z.infer<typeof contentAssignmentHistoryQuerySchema>;

export const contentAssignmentHistoryRowSchema = z.strictObject({
  id: z.string().uuid(),
  revision: z.number().int().positive(),
  previousName: z.string().nullable(),
  assigneeName: z.string().nullable(),
  actorName: z.string(),
  createdAt: z.string(),
});
export const contentAssignmentDtoSchema = contentAssignmentSummarySchema.extend({
  members: z.array(contentAssignmentMemberSchema),
  history: z.strictObject({
    rows: z.array(contentAssignmentHistoryRowSchema),
    nextCursor: z.string().uuid().nullable(),
  }),
});
export type ContentAssignmentDto = z.infer<typeof contentAssignmentDtoSchema>;
