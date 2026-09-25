import {
  CLAIM_REVIEW_FAILURES,
  CLAIM_REVIEW_STATUSES,
  type ClaimReviewClaim,
  type ClaimReviewEvidence,
} from "@pubrick/shared";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth.js";
import { contentItems } from "./content-items.js";
import { enumCheck } from "./enum-check.js";

/** One explicit evidence review of an exact saved article body. */
export const claimReviews = pgTable(
  "claim_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    /** Preserve review usage-loss accounting if the archived draft is deleted. */
    contentItemId: uuid("content_item_id").references(() => contentItems.id, {
      onDelete: "set null",
    }),
    bodyHash: text("body_hash").notNull(),
    status: text("status", { enum: CLAIM_REVIEW_STATUSES }).notNull().default("queued"),
    claims: jsonb("claims").$type<ClaimReviewClaim[]>().notNull().default([]),
    errorCode: text("error_code", { enum: CLAIM_REVIEW_FAILURES }),
    /** Random per-delivery fence; a redelivered pg-boss job keeps its job id. */
    activeDeliveryToken: uuid("active_delivery_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    /** Paid AI calls whose usage row could not be persisted. */
    unrecordedCalls: integer("unrecorded_calls").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("claim_reviews_org_item_created_idx").on(
      t.orgId,
      t.contentItemId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    uniqueIndex("claim_reviews_one_active_body_idx")
      .on(t.orgId, t.contentItemId, t.bodyHash)
      .where(sql`${t.status} IN ('queued', 'running')`),
    enumCheck("claim_reviews_status_check", t.status, CLAIM_REVIEW_STATUSES),
    check("claim_reviews_body_hash_check", sql`length(${t.bodyHash}) = 64`),
    check("claim_reviews_unrecorded_calls_check", sql`${t.unrecordedCalls} >= 0`),
    check(
      "claim_reviews_error_code_check",
      sql`${t.errorCode} IS NULL OR ${t.errorCode} IN (${sql.raw(CLAIM_REVIEW_FAILURES.map((value) => `'${value}'`).join(", "))})`,
    ),
    check(
      "claim_reviews_result_invariant",
      sql`((${t.status} = 'queued' OR ${t.status} = 'running') AND ${t.completedAt} IS NULL AND ${t.errorCode} IS NULL) OR (${t.status} = 'ready' AND ${t.completedAt} IS NOT NULL AND ${t.errorCode} IS NULL) OR (${t.status} = 'failed' AND ${t.completedAt} IS NOT NULL AND ${t.errorCode} IS NOT NULL)`,
    ),
  ],
);

/** One immutable, editor-visible proposal for a draft's exact reviewed body. */
export const claimCorrectionProposals = pgTable(
  "claim_correction_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orgId: text("org_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    contentItemId: uuid("content_item_id")
      .notNull()
      .references(() => contentItems.id, { onDelete: "cascade" }),
    reviewId: uuid("review_id")
      .notNull()
      .references(() => claimReviews.id, { onDelete: "cascade" }),
    claimIndex: integer("claim_index").notNull(),
    sourceBody: text("source_body").notNull(),
    sourceBodyHash: text("source_body_hash").notNull(),
    claim: text("claim").notNull(),
    replacement: text("replacement").notNull(),
    reason: text("reason").notNull(),
    evidence: jsonb("evidence").$type<ClaimReviewEvidence[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("claim_correction_proposals_one_per_item_idx").on(t.contentItemId),
    index("claim_correction_proposals_org_review_idx").on(t.orgId, t.reviewId),
    check("claim_correction_proposals_claim_index_check", sql`${t.claimIndex} >= 0`),
    check(
      "claim_correction_proposals_source_body_check",
      sql`length(${t.sourceBody}) BETWEEN 1 AND 4096`,
    ),
    check(
      "claim_correction_proposals_source_hash_check",
      sql`${t.sourceBodyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "claim_correction_proposals_claim_check",
      sql`length(btrim(${t.claim})) BETWEEN 1 AND 1000`,
    ),
    check(
      "claim_correction_proposals_replacement_check",
      sql`length(btrim(${t.replacement})) BETWEEN 1 AND 1000`,
    ),
    check(
      "claim_correction_proposals_reason_check",
      sql`length(btrim(${t.reason})) BETWEEN 1 AND 2000`,
    ),
    check(
      "claim_correction_proposals_evidence_check",
      sql`jsonb_typeof(${t.evidence}) = 'array' AND jsonb_array_length(${t.evidence}) BETWEEN 1 AND 5`,
    ),
  ],
);
