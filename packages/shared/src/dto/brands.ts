import { z } from "zod";

export const brandCreateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  voice: z.string().max(2000).optional(),
  audience: z.string().max(2000).optional(),
  contentLanguage: z.string().min(2).max(10).default("en"),
});
export type BrandCreate = z.infer<typeof brandCreateSchema>;

export const brandUpdateSchema = brandCreateSchema.partial();
export type BrandUpdate = z.infer<typeof brandUpdateSchema>;
