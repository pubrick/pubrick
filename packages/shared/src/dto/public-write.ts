import { z } from "zod";
import {
  CONTENT_STATUSES,
  type ContentCursor,
  contentCreateSchema,
  decodeContentCursor,
  encodeContentCursor,
  MAX_CONTENT_PAGE_SIZE,
} from "./content.js";
import { RUN_STATUSES, runCreateSchema } from "./runs.js";

export const PUBLIC_WRITE_OPERATIONS = ["content:create", "generation:create"] as const;
export type PublicWriteOperation = (typeof PUBLIC_WRITE_OPERATIONS)[number];
export const PAID_GENERATION_CONSENT_VERSION = "byok-paid-generation-v1" as const;
export const PUBLIC_REQUEST_HASH_VERSION = "parsed-dto-v1" as const;
export const MAX_PUBLIC_OPERATION_RECORDS = 100_000;
export const MAX_PUBLIC_OPERATION_RECORDS_CONFIG = 1_000_000;
export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9._-]{8,128}$/);
export const publicDraftCreateSchema = contentCreateSchema.strict();
export type PublicDraftCreate = z.infer<typeof publicDraftCreateSchema>;
export const publicRunCreateSchema = runCreateSchema
  .safeExtend({
    allowPaidGeneration: z.literal(true),
    consentVersion: z.literal(PAID_GENERATION_CONSENT_VERSION),
  })
  .strict();
export type PublicRunCreate = z.infer<typeof publicRunCreateSchema>;
export const publicDraftCreateResultSchema = z.strictObject({
  id: z.uuid(),
  status: z.literal("draft"),
  origin: z.literal("external"),
  requiresReview: z.literal(true),
});
export const publicRunCreateResultSchema = z.strictObject({
  id: z.uuid(),
  status: z.literal("queued"),
});
export const publicRunStatusSchema = z.strictObject({
  id: z.uuid(),
  status: z.enum(RUN_STATUSES),
  contentItemId: z.uuid().nullable(),
  error: z.enum(["generation_failed", "cancelled"]).nullable(),
  cost: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("known"), amountUsd: z.string().regex(/^\d+(?:\.\d+)?$/) }),
    z.strictObject({ status: z.literal("unknown") }),
  ]),
});
export const publicContentSummaryV2Schema = z.strictObject({
  id: z.uuid(),
  brandId: z.uuid(),
  title: z.string().nullable(),
  status: z.enum(CONTENT_STATUSES),
  origin: z.enum(["ai", "human", "external"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export const publicContentDetailV2Schema = publicContentSummaryV2Schema.extend({
  body: z.string(),
});
export const publicContentListV2Schema = z.strictObject({
  rows: z.array(publicContentSummaryV2Schema),
  nextCursor: z.string().nullable(),
});
export const publicContentListQuerySchema = z.strictObject({
  status: z.enum(CONTENT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_CONTENT_PAGE_SIZE).optional(),
  cursor: z.string().max(512).optional(),
});

// V1 bytes remain unchanged. The version/audience prefix is outside their alphabet.
const V2_CONTENT_CURSOR_PREFIX = "v2.content.";
export function encodePublicContentCursorV2(cursor: ContentCursor): string {
  return V2_CONTENT_CURSOR_PREFIX + encodeContentCursor(cursor);
}
export function decodePublicContentCursorV2(raw: string): ContentCursor | null {
  return raw.startsWith(V2_CONTENT_CURSOR_PREFIX)
    ? decodeContentCursor(raw.slice(V2_CONTENT_CURSOR_PREFIX.length))
    : null;
}

export type PublicDraftCreateResult = z.infer<typeof publicDraftCreateResultSchema>;
export type PublicRunCreateResult = z.infer<typeof publicRunCreateResultSchema>;
export type PublicRunStatus = z.infer<typeof publicRunStatusSchema>;
export type PublicContentSummaryV2 = z.infer<typeof publicContentSummaryV2Schema>;
export type PublicContentDetailV2 = z.infer<typeof publicContentDetailV2Schema>;
export type PublicContentListV2 = z.infer<typeof publicContentListV2Schema>;
