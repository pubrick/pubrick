import { z } from "zod";
import { MAX_BODY_LENGTH } from "./dto/content.js";

/** Native destinations that prepare containers before final publication. */
export const META_STAGED_PLATFORM_IDS = ["threads", "instagram_native"] as const;
export type MetaStagedPlatformId = (typeof META_STAGED_PLATFORM_IDS)[number];

export const META_PUBLICATION_PHASES = [
  "preparation_intent",
  "waiting",
  "final_intent",
  "published",
  "preparation_unknown",
  "final_unknown",
  "published_without_receipt",
  "failed",
  "cancelled",
] as const;
export type MetaPublicationPhase = (typeof META_PUBLICATION_PHASES)[number];
export const META_PUBLICATION_FAILURES = [
  "preparation_receipt_lost",
  "container_rejected",
  "container_expired",
  "preparation_deadline",
  "input_changed",
  "connection_changed",
  "permission_refused",
  "final_outcome_unknown",
  "published_without_receipt",
  "recording_failed",
] as const;
export type MetaPublicationFailure = (typeof META_PUBLICATION_FAILURES)[number];

export const META_PREPARATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const META_PUBLICATION_LEASE_MS = 120_000;
export const META_PUBLICATION_POLL_DELAY_MS = 30_000;
export const META_PUBLICATION_MAX_POLLS = 120;

export const approvedJpegIdentitySchema = z.strictObject({
  mediaId: z.uuid(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: z.literal("image/jpeg"),
  width: z.number().int().positive().max(20_000),
  height: z.number().int().positive().max(20_000),
  byteSize: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024),
});
export type ApprovedJpegIdentity = z.infer<typeof approvedJpegIdentitySchema>;

/** Exact reviewed input, with no capability bearer URL or credential metadata. */
export const frozenMetaPublicationInputSchema = z.strictObject({
  version: z.literal(1),
  platform: z.enum(META_STAGED_PLATFORM_IDS),
  text: z.string().max(MAX_BODY_LENGTH),
  image: approvedJpegIdentitySchema.optional(),
});
export type FrozenMetaPublicationInput = z.infer<typeof frozenMetaPublicationInputSchema>;
export const metaPublicationIdentitySchema = z.strictObject({
  orgId: z.string().min(1).max(200),
  brandId: z.uuid(),
  adaptationId: z.uuid(),
  channelId: z.uuid(),
  attempt: z.number().int().positive(),
  inputHash: z.string().regex(/^[a-f0-9]{64}$/),
  target: z.string().min(1).max(300),
  credentialGeneration: z.number().int().nonnegative(),
});
export type MetaPublicationIdentity = z.infer<typeof metaPublicationIdentitySchema>;

/** Transient server-issued access to one immutable approved asset, never an export field. */
export interface ApprovedJpegCapability {
  url: string;
  expiresAt: string;
  orgId: string;
  adaptationId: string;
  attempt: number;
  mediaId: string;
  sha256: string;
  purpose: "meta_preparation";
}

/** Waiting work always resumes the original attempt; it is not a new publish job. */
export const META_PUBLICATION_QUEUE = "meta-publication";
export const META_PUBLICATION_DLQ = "meta-publication-dlq";
export type MetaPublicationJob = { orgId: string; adaptationId: string; stageId: string };
export const META_PUBLICATION_QUEUE_OPTIONS = {
  // Recovery belongs to the durable stage. Retrying a physical side effect is unsafe.
  retryLimit: 0,
  // The authority lease bounds new requests; receipt recording still needs its
  // final request (30s), existing receipt budget (41.2s), and DB margin after
  // the last authority check. Worker tests pin this against actual budgets.
  expireInSeconds: META_PUBLICATION_LEASE_MS / 1000 + 90,
  heartbeatSeconds: 30,
  deadLetter: META_PUBLICATION_DLQ,
} as const;
