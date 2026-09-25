import { z } from "zod";
import { commentAnalysisResultSchema } from "./sources.js";

export const PAID_REPLY_BLOCK_REASONS = [
  "hourly_limit",
  "brand_daily_threshold",
  "org_daily_threshold",
  "unknown_spend",
  "unpriced_model",
  "no_key",
  "request_too_large",
  "setting_changed",
  "sample_changed",
  "target_unavailable",
  "day_changed",
  "price_changed",
] as const;
export const paidReplyBlockReasonSchema = z.enum(PAID_REPLY_BLOCK_REASONS);

/** Server validates IANA membership and the brand ≤ organization rule. */
export const organizationPaidReplySettingsUpdateSchema = z.strictObject({
  timezone: z.string().min(1).max(100),
  dailyThresholdUsd: z.number().positive().max(5),
});
export const organizationPaidReplySettingsDtoSchema =
  organizationPaidReplySettingsUpdateSchema.extend({
    revision: z.number().int().nonnegative(),
    admittedCostUsd: z.number().nonnegative(),
    blockedReason: paidReplyBlockReasonSchema.nullable(),
  });
export const brandPaidReplySettingsUpdateSchema = z.strictObject({
  sourceEnabled: z.boolean(),
  publicationEnabled: z.boolean(),
  dailyThresholdUsd: z.number().positive().max(5),
});
/** Granular writes keep one page from changing the other page's revision. */
export const sourcePaidReplyConsentUpdateSchema = z.strictObject({ enabled: z.boolean() });
export const publicationPaidReplyConsentUpdateSchema = z.strictObject({ enabled: z.boolean() });
export const brandPaidReplyThresholdUpdateSchema = z.strictObject({
  dailyThresholdUsd: z.number().positive().max(5),
});
export const brandPaidReplySettingsDtoSchema = brandPaidReplySettingsUpdateSchema.extend({
  sourceRevision: z.number().int().nonnegative(),
  publicationRevision: z.number().int().nonnegative(),
  thresholdRevision: z.number().int().nonnegative(),
  admittedCostUsd: z.number().nonnegative(),
  blockedReason: paidReplyBlockReasonSchema.nullable(),
});

const sampleVersionSchema = z.uuid().nullable();
const currentAnalysisSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("queued"), sampleVersion: sampleVersionSchema }),
  z.strictObject({ status: z.literal("analyzing"), sampleVersion: sampleVersionSchema }),
  z.strictObject({
    status: z.literal("ready"),
    sampleVersion: z.uuid(),
    result: commentAnalysisResultSchema,
    sampleSize: z.number().int().min(1).max(30),
    analyzedAt: z.iso.datetime(),
  }),
  z.strictObject({ status: z.literal("stale"), sampleVersion: sampleVersionSchema }),
  z.strictObject({ status: z.literal("no_comments"), sampleVersion: sampleVersionSchema }),
  z.strictObject({ status: z.literal("no_key"), sampleVersion: sampleVersionSchema }),
  z.strictObject({
    status: z.literal("blocked"),
    sampleVersion: sampleVersionSchema,
    reason: paidReplyBlockReasonSchema,
  }),
  z.strictObject({ status: z.literal("failed"), sampleVersion: sampleVersionSchema }),
  z.strictObject({ status: z.literal("unknown"), sampleVersion: sampleVersionSchema }),
  z.strictObject({ status: z.literal("not_analyzed"), sampleVersion: sampleVersionSchema }),
]);

export const paidReplyAnalysisDtoSchema = z.strictObject({
  current: currentAnalysisSchema,
  /** A refresh may fail or clear rows while the earlier aggregate remains readable. */
  earlierAnalysis: z
    .strictObject({
      sampleVersion: z.uuid(),
      result: commentAnalysisResultSchema,
      sampleSize: z.number().int().min(1).max(30),
      analyzedAt: z.iso.datetime(),
    })
    .optional(),
});
export type PaidReplyAnalysisDto = z.infer<typeof paidReplyAnalysisDtoSchema>;
export type BrandPaidReplySettingsDto = z.infer<typeof brandPaidReplySettingsDtoSchema>;
export type OrganizationPaidReplySettingsDto = z.infer<
  typeof organizationPaidReplySettingsDtoSchema
>;
