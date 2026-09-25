import { z } from "zod";

/** Organization-owned Yandex Search API key and its cloud folder. */
export const searchCredentialUpsertSchema = z.strictObject({
  apiKey: z.string().trim().min(8).max(4096),
  folderId: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_-]+$/),
});
export type SearchCredentialUpsert = z.infer<typeof searchCredentialUpsertSchema>;

/** The only credential shape returned by the HTTP API. */
export const searchCredentialPublicSchema = z.strictObject({
  configured: z.boolean(),
  folderId: z.string().nullable(),
  updatedAt: z.iso.datetime().nullable(),
});
export type SearchCredentialPublic = z.infer<typeof searchCredentialPublicSchema>;

export const SEARCH_REQUEST_STATUSES = ["reserved", "succeeded", "failed"] as const;
export type SearchRequestStatus = (typeof SEARCH_REQUEST_STATUSES)[number];
