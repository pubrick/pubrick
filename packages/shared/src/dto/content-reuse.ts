import { z } from "zod";
import { CONTENT_ORIGINS, type ContentStatus } from "./content.js";
import { PAID_GENERATION_CONSENT_VERSION } from "./public-write.js";
import { CONTENT_TYPES, runCreateSchema } from "./runs.js";
import { hasNulByte, NO_NUL_BYTE_MESSAGE } from "./text.js";

export const CONTENT_REUSE_OPERATIONS = ["reuse", "reuse-retry"] as const;
export type ContentReuseOperation = (typeof CONTENT_REUSE_OPERATIONS)[number];
export const CONTENT_REUSE_TARGET_KINDS = ["content", "run"] as const;
export type ContentReuseTargetKind = (typeof CONTENT_REUSE_TARGET_KINDS)[number];
export const CONTENT_REUSE_HASH_VERSION = "parsed-dto-v1" as const;
export const CONTENT_REUSE_DIGEST_VERSION = "source-v1" as const;
export const MAX_CONTENT_REUSE_OPERATIONS = 10_000;
export const CONTENT_REUSE_ELIGIBLE_STATUSES = [
  "draft",
  "approved",
  "published",
  "partially_published",
] as const satisfies readonly ContentStatus[];

export const contentReuseActorIdSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !hasNulByte(value), NO_NUL_BYTE_MESSAGE);
export const contentReuseDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const revisionSchema = z.number().int().min(0);
const consentFields = {
  allowPaidGeneration: z.literal(true),
  consentVersion: z.literal(PAID_GENERATION_CONSENT_VERSION),
};

/** Session-only admission. Source, lineage, provider and delivery fields stay server-owned. */
export const contentReuseCreateSchema = z.strictObject({
  expectedSourceRevision: revisionSchema,
  expectedSourceDigest: contentReuseDigestSchema,
  title: runCreateSchema.shape.title,
  brief: runCreateSchema.shape.brief,
  contentType: z.enum(CONTENT_TYPES),
  channelIds: runCreateSchema.shape.channelIds,
  ...consentFields,
});
export type ContentReuseCreate = z.infer<typeof contentReuseCreateSchema>;

/** Retrying uses the frozen run's instructions/channels; this body grants only paid consent. */
export const contentReuseRetrySchema = z.strictObject(consentFields);
export type ContentReuseRetry = z.infer<typeof contentReuseRetrySchema>;
export const contentReuseResultSchema = z.strictObject({
  id: z.uuid(),
  status: z.literal("queued"),
});
export type ContentReuseResult = z.infer<typeof contentReuseResultSchema>;

/** Bound after shared newline normalization, reject blank saved text, and never truncate. */
export const contentReuseMaterialSchema = runCreateSchema.shape.material
  .unwrap()
  .refine((value) => value.trim().length > 0, "Source material must not be blank");
// Saved titles are exact digest evidence, not newly submitted output titles.
const savedTitleSchema = z
  .string()
  .refine((value) => !hasNulByte(value), NO_NUL_BYTE_MESSAGE)
  .nullable();

/** Backend hashes this parsed payload with its maintained stable serializer and SHA-256. */
export const contentReuseSourceDigestPayloadSchema = z.strictObject({
  version: z.literal(CONTENT_REUSE_DIGEST_VERSION),
  contentId: z.uuid(),
  brandId: z.uuid(),
  title: savedTitleSchema,
  bodyRevision: revisionSchema,
  material: contentReuseMaterialSchema,
});
export type ContentReuseSourceDigestPayload = z.infer<typeof contentReuseSourceDigestPayloadSchema>;
export const contentReuseSourcePreviewSchema = z.strictObject({
  id: z.uuid(),
  brandId: z.uuid(),
  title: savedTitleSchema,
  bodyRevision: revisionSchema,
  material: contentReuseMaterialSchema,
  status: z.enum(CONTENT_REUSE_ELIGIBLE_STATUSES),
  origin: z.enum(CONTENT_ORIGINS),
  digest: contentReuseDigestSchema,
});
export type ContentReuseSourcePreview = z.infer<typeof contentReuseSourcePreviewSchema>;

export {
  type ContentReuseAttribution,
  contentReuseAttributionSchema,
} from "./content-reuse-attribution.js";
