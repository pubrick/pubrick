import { z } from "zod";
import { CONTENT_STATUSES } from "./content.js";
import { promptRoleSchema } from "./prompts.js";

/** The source is normalized and checked by the server's bounded renderer. */
export const roleTemplateSourceSchema = z.object({ source: z.string() });
export type RoleTemplateSource = z.infer<typeof roleTemplateSourceSchema>;

export const roleTemplateActivationSchema = z.object({
  revisionId: z.string().uuid().nullable(),
  expectedRevisionId: z.string().uuid().nullable(),
  expectedGeneration: z.number().int().nonnegative(),
});
export type RoleTemplateActivation = z.infer<typeof roleTemplateActivationSchema>;

export const roleTemplateCursorSchema = z.coerce.number().int().positive().optional();

export const roleTemplateRevisionDtoSchema = z.object({
  id: z.string().uuid(),
  role: promptRoleSchema,
  version: z.number().int().positive(),
  source: z.string(),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string(),
});
export type RoleTemplateRevisionDto = z.infer<typeof roleTemplateRevisionDtoSchema>;

export const roleTemplateHeadDtoSchema = z.object({
  role: promptRoleSchema,
  activeRevisionId: z.string().uuid().nullable(),
  activeVersion: z.number().int().positive().nullable(),
  generation: z.number().int().nonnegative(),
  builtInSource: z.string(),
});
export type RoleTemplateHeadDto = z.infer<typeof roleTemplateHeadDtoSchema>;

export const roleTemplateHistoryDtoSchema = z.object({
  rows: z.array(roleTemplateRevisionDtoSchema),
  nextCursor: z.number().int().positive().nullable(),
});
export type RoleTemplateHistoryDto = z.infer<typeof roleTemplateHistoryDtoSchema>;

export const roleTemplatePreviewDtoSchema = z.object({
  source: z.string(),
  renderedBody: z.string(),
  variables: z.array(z.string()),
  renderedBodyBytes: z.number().int().nonnegative(),
  sampleInstructionBytes: z.number().int().nonnegative(),
});
export type RoleTemplatePreviewDto = z.infer<typeof roleTemplatePreviewDtoSchema>;

const outcomeCountsSchema = z.object({
  runCount: z.number().int().nonnegative(),
  succeededRuns: z.number().int().nonnegative(),
  publishedRuns: z.number().int().nonnegative(),
  currentItemStatuses: z.object(
    Object.fromEntries(
      CONTENT_STATUSES.map((status) => [status, z.number().int().nonnegative()]),
    ) as Record<(typeof CONTENT_STATUSES)[number], z.ZodNumber>,
  ),
  withoutCurrentItem: z.number().int().nonnegative(),
  reviewActs: z.object({
    approved: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
  }),
});

export const roleTemplateOutcomeRowDtoSchema = z.discriminatedUnion("kind", [
  outcomeCountsSchema.extend({
    kind: z.literal("default"),
    revisionId: z.null(),
    version: z.null(),
  }),
  outcomeCountsSchema.extend({
    kind: z.literal("revision"),
    revisionId: z.string().uuid(),
    version: z.number().int().positive(),
  }),
]);
export type RoleTemplateOutcomeRowDto = z.infer<typeof roleTemplateOutcomeRowDtoSchema>;

export const roleTemplateOutcomeComparisonDtoSchema = z.object({
  brandId: z.string().uuid(),
  role: promptRoleSchema,
  days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
  activeRevisionId: z.string().uuid().nullable(),
  default: roleTemplateOutcomeRowDtoSchema,
  rows: z.array(roleTemplateOutcomeRowDtoSchema),
  nextCursor: z.number().int().positive().nullable(),
});
export type RoleTemplateOutcomeComparisonDto = z.infer<
  typeof roleTemplateOutcomeComparisonDtoSchema
>;
