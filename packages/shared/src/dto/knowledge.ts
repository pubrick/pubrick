import { z } from "zod";
import { hasNulByte, NO_NUL_BYTE_MESSAGE } from "./text.js";

export const KNOWLEDGE_CATEGORIES = [
  "product_info",
  "brand_guidelines",
  "case_study",
  "tone_example",
  "competitor",
  "customer",
] as const;

/** Stored verbatim after trimming, so imported and user-defined labels retain their meaning. */
export const knowledgeCategorySchema = z
  .string()
  .refine((value) => !/[\p{Cc}]/u.test(value), "Category cannot contain control characters")
  .trim()
  .min(1)
  .max(100);

export const knowledgeCreateSchema = z.object({
  brandId: z.uuid(),
  title: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .refine((value) => !hasNulByte(value), NO_NUL_BYTE_MESSAGE),
  content: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .refine((value) => !hasNulByte(value), NO_NUL_BYTE_MESSAGE),
  category: knowledgeCategorySchema,
  tags: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(50)
        .refine((value) => !hasNulByte(value), NO_NUL_BYTE_MESSAGE),
    )
    .max(20)
    .default([]),
});
export type KnowledgeCreate = z.infer<typeof knowledgeCreateSchema>;

export const knowledgeUpdateSchema = knowledgeCreateSchema
  .omit({ brandId: true })
  .partial()
  .extend({ isActive: z.boolean().optional() });
export type KnowledgeUpdate = z.infer<typeof knowledgeUpdateSchema>;

export const knowledgeImportSchema = z.object({
  brandId: z.uuid(),
  entries: z
    .array(
      knowledgeCreateSchema.omit({ brandId: true }).extend({ isActive: z.boolean().default(true) }),
    )
    .min(1)
    .max(500),
});
export type KnowledgeImport = z.infer<typeof knowledgeImportSchema>;

export const knowledgeBatchIndexSchema = z.object({ brandId: z.uuid() });
export type KnowledgeBatchIndex = z.infer<typeof knowledgeBatchIndexSchema>;

export const knowledgeAutoIndexSchema = z.object({ brandId: z.uuid(), enabled: z.boolean() });
export type KnowledgeAutoIndex = z.infer<typeof knowledgeAutoIndexSchema>;
