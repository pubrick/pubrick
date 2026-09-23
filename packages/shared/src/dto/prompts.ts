import { z } from "zod";

export const PROMPT_ROLES = ["researcher", "writer", "editor", "factcheck", "adapter"] as const;
export const promptRoleSchema = z.enum(PROMPT_ROLES);
export type PromptRole = z.infer<typeof promptRoleSchema>;

/** Extra organization-authored guidance; the built-in safety and output rules stay in code. */
export const promptRevisionCreateSchema = z.object({
  guidance: z.string().trim().max(6000),
});
export type PromptRevisionCreate = z.infer<typeof promptRevisionCreateSchema>;

export const promptRevisionDtoSchema = z.object({
  id: z.string().uuid(),
  role: promptRoleSchema,
  version: z.number().int().positive(),
  guidance: z.string(),
  createdAt: z.string(),
});
export type PromptRevisionDto = z.infer<typeof promptRevisionDtoSchema>;
