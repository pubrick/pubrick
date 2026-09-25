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
  stale: z.boolean(),
  claims: z.array(claimReviewClaimSchema),
  errorCode: z.enum(CLAIM_REVIEW_FAILURES).nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
});
export type ClaimReviewDto = z.infer<typeof claimReviewDtoSchema>;
