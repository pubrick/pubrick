import { z } from "zod";
import { MAX_BODY_LENGTH } from "./content.js";

export const CLAIM_REVIEW_STATUSES = ["queued", "running", "ready", "failed"] as const;
export type ClaimReviewStatus = (typeof CLAIM_REVIEW_STATUSES)[number];

export const CLAIM_REVIEW_OUTCOMES = [
  "evidence_supports",
  "evidence_conflicts",
  "insufficient",
  "search_unavailable",
] as const;
export type ClaimReviewOutcome = (typeof CLAIM_REVIEW_OUTCOMES)[number];

/** Safe, user-facing failure codes; never a provider error or credential. */
export const CLAIM_REVIEW_FAILURES = [
  "no_ai_key",
  "no_search_key",
  "automatic_disabled",
  "source_changed",
  "provider_unavailable",
  "invalid_response",
  "internal_error",
] as const;
export type ClaimReviewFailure = (typeof CLAIM_REVIEW_FAILURES)[number];

export const claimReviewStartSchema = z.strictObject({
  expectedBody: z.string().min(1).max(MAX_BODY_LENGTH),
});
export type ClaimReviewStart = z.infer<typeof claimReviewStartSchema>;

export const claimReviewEvidenceSchema = z.strictObject({
  title: z.string(),
  url: z.url(),
  snippet: z.string(),
});
export type ClaimReviewEvidence = z.infer<typeof claimReviewEvidenceSchema>;

export const claimReviewClaimSchema = z.strictObject({
  claim: z.string(),
  outcome: z.enum(CLAIM_REVIEW_OUTCOMES),
  evidence: z.array(claimReviewEvidenceSchema),
});
export type ClaimReviewClaim = z.infer<typeof claimReviewClaimSchema>;

export const claimReviewDtoSchema = z.strictObject({
  id: z.uuid(),
  contentItemId: z.uuid(),
  status: z.enum(CLAIM_REVIEW_STATUSES),
  trigger: z.enum(["manual", "automatic"]),
  stale: z.boolean(),
  claims: z.array(claimReviewClaimSchema),
  errorCode: z.enum(CLAIM_REVIEW_FAILURES).nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
});
export type ClaimReviewDto = z.infer<typeof claimReviewDtoSchema>;

/** Request a reviewable replacement for one claim in an exact saved body. */
export const claimCorrectionRequestSchema = z.strictObject({
  expectedBody: z.string().min(1).max(MAX_BODY_LENGTH),
  reviewId: z.uuid(),
  claimIndex: z.number().int().min(0),
});
export type ClaimCorrectionRequest = z.infer<typeof claimCorrectionRequestSchema>;

/** Immutable proposed edit. Applying it is a separate editor action. */
export const claimCorrectionProposalDtoSchema = z.strictObject({
  id: z.uuid(),
  contentItemId: z.uuid(),
  reviewId: z.uuid(),
  claimIndex: z.number().int().min(0),
  sourceBody: z.string().min(1).max(MAX_BODY_LENGTH),
  claim: z.string().min(1).max(1000).regex(/\S/),
  replacement: z.string().min(1).max(1000).regex(/\S/),
  reason: z.string().min(1).max(2000).regex(/\S/),
  evidence: z
    .array(
      z.strictObject({
        title: z.string().min(1).max(500).regex(/\S/),
        url: z.url().max(2048),
        snippet: z.string().min(1).max(2000).regex(/\S/),
      }),
    )
    .min(1)
    .max(5),
  createdAt: z.iso.datetime(),
});
export type ClaimCorrectionProposalDto = z.infer<typeof claimCorrectionProposalDtoSchema>;

/** Accepted correction survives dismissal of its staged proposal. */
export const acceptedClaimCorrectionDtoSchema = claimCorrectionProposalDtoSchema
  .omit({ sourceBody: true, createdAt: true })
  .extend({
    fragmentVersionId: z.uuid(),
    sourceBodyHash: z.string().regex(/^[0-9a-f]{64}$/),
    acceptedAt: z.iso.datetime(),
  });
export type AcceptedClaimCorrectionDto = z.infer<typeof acceptedClaimCorrectionDtoSchema>;

export const acceptedClaimCorrectionListQuerySchema = z.strictObject({
  cursor: z.uuid().optional(),
});
export type AcceptedClaimCorrectionListQuery = z.infer<
  typeof acceptedClaimCorrectionListQuerySchema
>;

export const acceptedClaimCorrectionListDtoSchema = z.strictObject({
  rows: z.array(acceptedClaimCorrectionDtoSchema),
  nextCursor: z.uuid().nullable(),
});
export type AcceptedClaimCorrectionListDto = z.infer<typeof acceptedClaimCorrectionListDtoSchema>;
