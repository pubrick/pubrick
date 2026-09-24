import { z } from "zod";

export const MAX_ACTIVE_API_KEYS = 20;
export const API_KEY_SCOPES = ["content:read"] as const;

export const apiKeyCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(80),
  scope: z.enum(API_KEY_SCOPES),
});

export type ApiKeyCreate = z.infer<typeof apiKeyCreateSchema>;

export const apiKeyPublicSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  prefix: z.string(),
  scope: z.enum(API_KEY_SCOPES),
  createdAt: z.coerce.date(),
  revokedAt: z.coerce.date().nullable(),
});

export type ApiKeyPublic = z.infer<typeof apiKeyPublicSchema>;
