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
