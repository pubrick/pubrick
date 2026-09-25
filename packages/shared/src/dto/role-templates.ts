import { z } from "zod";
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
  /** Built-in source is unavailable until the default-body manifest is extracted. */
  builtInSource: z.string().nullable(),
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
  /** Filled when the code-owned full-instruction composer is available. */
  sampleInstructionBytes: z.number().int().nonnegative().nullable(),
});
export type RoleTemplatePreviewDto = z.infer<typeof roleTemplatePreviewDtoSchema>;
