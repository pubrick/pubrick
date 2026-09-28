import { z } from "zod";
import { RUN_STATUSES } from "./runs.js";

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

/** Recent operator-requested calendar passes. Slot links are durable provenance. */
export const manualTopicPlanAttemptSchema = z.object({
  id: z.uuid(),
  status: z.enum(["queued", "running", "completed", "failed"]),
  errorCode: z.enum(["worker_failed"]).nullable(),
  createdAt: z.iso.datetime(),
  startedAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  slots: z.array(
    z.object({ id: z.uuid(), scheduledAt: z.iso.datetime(), topicTitle: z.string().nullable() }),
  ),
  createdCount: z.number().int().nonnegative(),
});
export type ManualTopicPlanAttempt = z.infer<typeof manualTopicPlanAttemptSchema>;

/** One read-only, brand-scoped view of durable Autopilot operations. */
export const AUTOPILOT_OPERATION_KINDS = [
  "scheduled_scan",
  "automatic_dispatch",
  "manual_generation",
  "manual_topic_plan",
  "topic_suggestions",
] as const;
export const autopilotOperationsQuerySchema = z.object({
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,128}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});
export type AutopilotOperationsQuery = z.infer<typeof autopilotOperationsQuerySchema>;

const operationBase = { id: z.uuid(), occurredAt: z.iso.datetime() };
const generationLinks = {
  runId: z.uuid().nullable(),
  runStatus: z.enum(RUN_STATUSES).nullable(),
  topicId: z.uuid().nullable(),
  topicTitle: z.string().nullable(),
};
export const autopilotOperationSchema = z.discriminatedUnion("kind", [
  z.object({
    ...operationBase,
    kind: z.literal("scheduled_scan"),
    admission: z.object({
      status: z.enum(AUTOPILOT_SCAN_STATUSES),
      decision: z.enum(AUTOPILOT_SCAN_DECISIONS),
    }),
    ...generationLinks,
  }),
  z.object({
    ...operationBase,
    kind: z.literal("automatic_dispatch"),
    admission: z.object({ status: z.literal("dispatched"), decision: z.literal("dispatched") }),
    ...generationLinks,
  }),
  z.object({
    ...operationBase,
    kind: z.literal("manual_generation"),
    admission: z.object({
      status: z.enum(AUTOPILOT_MANUAL_STATUSES),
      decision: z.enum(AUTOPILOT_DECISIONS).nullable(),
    }),
    ...generationLinks,
  }),
  z.object({
    ...operationBase,
    kind: z.literal("manual_topic_plan"),
    status: z.enum(["queued", "running", "completed", "failed"]),
    errorCode: z.enum(["worker_failed"]).nullable(),
    createdCount: z.number().int().nonnegative(),
    slots: z.array(
      z.object({ id: z.uuid(), scheduledAt: z.iso.datetime(), topicTitle: z.string().nullable() }),
    ),
  }),
  z.object({
    ...operationBase,
    kind: z.literal("topic_suggestions"),
    status: z.enum(["queued", "running", "succeeded", "failed"]),
    origin: z.enum(["manual", "automatic"]),
    localDate: z.iso.date().nullable(),
    errorCode: z.enum(["no_api_key", "unreadable_key", "model_failed"]).nullable(),
    suggestionCount: z.number().int().nonnegative(),
  }),
]);
export type AutopilotOperation = z.infer<typeof autopilotOperationSchema>;
export const autopilotOperationsPageSchema = z.object({
  rows: z.array(autopilotOperationSchema),
  nextCursor: z.string().nullable(),
});
export type AutopilotOperationsPage = z.infer<typeof autopilotOperationsPageSchema>;
