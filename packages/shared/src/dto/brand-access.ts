import { z } from "zod";

/** The complete set of member IDs allowed to work with this brand. */
export const brandAccessReplaceSchema = z.strictObject({
  memberIds: z
    .array(z.string().min(1))
    .max(10000)
    .refine((ids) => new Set(ids).size === ids.length, "Member IDs must be unique"),
});

export type BrandAccessReplace = z.infer<typeof brandAccessReplaceSchema>;
