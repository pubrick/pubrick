import { adaptationLimit, COVER_SUPPORTED_PLATFORMS } from "@pubrick/shared";
import { isScheduleOverdue } from "./adaptations";

type ScheduledAdaptation = {
  channelId: string;
  body: string | null;
  scheduledAt: string | null;
  status: string;
};

type ScheduledItem = {
  status: string;
  body: string;
  coverMediaId: string | null;
  videoMediaId: string | null;
  adaptations: readonly ScheduledAdaptation[];
};

export type ScheduledPreflightIssue =
  | "channel_unknown"
  | "body_empty"
  | "body_too_long"
  | "media_unsupported"
  | "media_conflict"
  | "slot_overdue"
  | "slot_due";

export type ScheduledPreflightRow = {
  channelId: string;
  bodyLength: number;
  bodyLimit: number | null;
  media: "text" | "cover" | "video";
  issues: ScheduledPreflightIssue[];
};

/** A read-only view of the saved post. The approval and worker remain authoritative. */
export function scheduledPreflight(
  item: ScheduledItem,
  channels: readonly { id: string; platform: string }[],
  now = Date.now(),
): ScheduledPreflightRow[] {
  if (item.status !== "approved") return [];
  const byId = new Map(channels.map((channel) => [channel.id, channel.platform]));
  return item.adaptations
    .filter((adaptation) => adaptation.status === "scheduled")
    .map((adaptation) => {
      const platform = byId.get(adaptation.channelId);
      const body = adaptation.body ?? item.body;
      const platformLimit = platform ? adaptationLimit(platform) : undefined;
      const bodyLimit =
        platform === "telegram" && item.videoMediaId ? 1024 : (platformLimit ?? null);
      const media = item.videoMediaId ? "video" : item.coverMediaId ? "cover" : "text";
      const issues: ScheduledPreflightIssue[] = [];
      if (platformLimit === undefined) issues.push("channel_unknown");
      if (body.trim().length === 0) issues.push("body_empty");
      else if (bodyLimit !== null && body.length > bodyLimit) issues.push("body_too_long");
      if (item.coverMediaId && item.videoMediaId) issues.push("media_conflict");
      else if (
        (media === "cover" &&
          platform !== undefined &&
          !(COVER_SUPPORTED_PLATFORMS as readonly string[]).includes(platform)) ||
        (media === "video" && platform !== undefined && !["telegram", "vk"].includes(platform))
      ) {
        issues.push("media_unsupported");
      }
      const due = adaptation.scheduledAt ? new Date(adaptation.scheduledAt).getTime() : NaN;
      if (
        !Number.isFinite(due) ||
        (adaptation.scheduledAt !== null && isScheduleOverdue(adaptation.scheduledAt, now))
      ) {
        issues.push("slot_overdue");
      } else if (due <= now) {
        issues.push("slot_due");
      }
      return {
        channelId: adaptation.channelId,
        bodyLength: body.length,
        bodyLimit,
        media,
        issues,
      };
    });
}
