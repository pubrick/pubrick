import { z } from "zod";

const channelIds = z
  .array(z.uuid())
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length);

/** Admission controls for scheduled draft generation. Defaults are disabled. */
export const autopilotConfigSchema = z
  .object({
    enabled: z.boolean(),
    /** Optional on writes so older clients do not reset an existing opt-in. */
    autoSuggestTopics: z.boolean().optional(),
    /** Optional on writes so older clients preserve the paid semantic-check opt-in. */
    semanticFilterBlockedTopics: z.boolean().optional(),
    /** Optional on writes so older clients do not reset an existing opt-in. */
    autoPlanTopics: z.boolean().optional(),
    channelIds,
    timezone: z
      .string()
      .min(1)
      .max(100)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat("en-US", { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, "Use an IANA time zone"),
    startHour: z.number().int().min(0).max(23),
    quietStartHour: z.number().int().min(0).max(23),
    quietEndHour: z.number().int().min(0).max(23),
    dailyRunLimit: z.number().int().min(1).max(5),
    /** Optional on writes so older clients retain the configured planning cap. */
    planningDailyLimit: z.number().int().min(1).max(5).optional(),
    dailySpendLimitUsd: z.number().min(0.01).max(1000),
  })
  .refine((value) => (!value.enabled && !value.autoPlanTopics) || value.channelIds.length > 0, {
    message: "Select at least one channel before enabling autopilot or topic planning",
    path: ["channelIds"],
  });
export type AutopilotConfig = z.infer<typeof autopilotConfigSchema>;

export const autopilotDefaults: AutopilotConfig = {
  enabled: false,
  autoSuggestTopics: false,
  semanticFilterBlockedTopics: false,
  autoPlanTopics: false,
  channelIds: [],
  timezone: "UTC",
  startHour: 9,
  quietStartHour: 22,
  quietEndHour: 8,
  dailyRunLimit: 1,
  planningDailyLimit: 1,
  dailySpendLimitUsd: 1,
};

export type AutopilotDispatch = {
  id: string;
  topicId: string;
  runId: string;
  localDate: string;
  createdAt: Date;
  runStatus: string;
};

/** Closed decisions from the same admission path used by scheduled Autopilot. */
export const AUTOPILOT_DECISIONS = [
  "disabled",
  "before_start",
  "quiet_hours",
  "quota_full",
  "budget_full",
  "unpriced_spend",
  "run_in_progress",
  "org_busy",
  "channels_missing",
  "no_approved_topic",
  "invalid_brief",
  "dispatched",
  "worker_failed",
] as const;
export const AUTOPILOT_MANUAL_STATUSES = ["queued", "running", "completed", "failed"] as const;
/** A scheduled scan records admission, not the eventual generation result. */
export const AUTOPILOT_SCAN_STATUSES = ["skipped", "dispatched", "failed"] as const;
export const AUTOPILOT_SCAN_DECISIONS = AUTOPILOT_DECISIONS;
export const autopilotScanQuerySchema = z.object({
  status: z.enum(AUTOPILOT_SCAN_STATUSES).optional(),
  cursor: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type AutopilotScanQuery = z.infer<typeof autopilotScanQuerySchema>;
export const autopilotScanEventSchema = z.object({
  id: z.uuid(),
  status: z.enum(AUTOPILOT_SCAN_STATUSES),
  decision: z.enum(AUTOPILOT_SCAN_DECISIONS),
  runId: z.uuid().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
});
export type AutopilotScanEvent = z.infer<typeof autopilotScanEventSchema>;
export const autopilotScanPageSchema = z.object({
  rows: z.array(autopilotScanEventSchema),
  nextCursor: z.uuid().nullable(),
});
export type AutopilotScanPage = z.infer<typeof autopilotScanPageSchema>;
export const autopilotManualAttemptSchema = z.object({
  id: z.uuid(),
  status: z.enum(AUTOPILOT_MANUAL_STATUSES),
  decision: z.enum(AUTOPILOT_DECISIONS).nullable(),
  runId: z.uuid().nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
});
export type AutopilotManualAttempt = z.infer<typeof autopilotManualAttemptSchema>;
