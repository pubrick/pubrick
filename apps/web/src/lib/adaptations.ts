import type { DeliveryOutcome } from "@pubrick/shared";
import type { StatusBadgeStatus } from "@/components/ui/status-badge";

/**
 * The two lifecycles the content screens render, and the colors they wear.
 *
 * Local copies of `@pubrick/db`'s `CONTENT_STATUSES` / `ADAPTATION_STATUSES`,
 * for the reason `lib/runs.ts` already states for `RUN_STATUSES`: the web
 * package has no database dependency and must not grow one for a string union.
 * They lived inline in `content/page.tsx` and `content/[id]/page.tsx` — two
 * copies of the same union and two copies of the same color map, which is one
 * copy too many now that both screens also have to agree about what "in
 * flight" means.
 */
export const CONTENT_STATUSES = ["draft", "approved", "rejected", "published", "failed"] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

export const ADAPTATION_STATUSES = [
  "pending",
  "scheduled",
  "queued",
  "publishing",
  "published",
  "failed",
] as const;
export type AdaptationStatus = (typeof ADAPTATION_STATUSES)[number];

/**
 * What actually happened to one channel's post: the api's own
 * `deliveryOutcome` field, re-exported so the badge map below is keyed on the
 * same union the response carries.
 *
 * It is `@pubrick/shared`'s, not a local copy, precisely because it is a WIRE
 * field — the reason `ADAPTATION_STATUSES` above is a copy does not reach it.
 * The seven values and what each of them means are documented there; the one
 * this screen exists to get right is `unknown`, a send whose answer never came
 * back, which is neither a success nor a failure.
 *
 * This module used to derive that seventh value itself, by matching a fixed
 * English sentence at the front of `lastError` — the only trace of an unknown
 * outcome that reached a browser before the api shipped the field. Rewording
 * the worker's log line turned every unknown delivery back into a plain red
 * "Failed", which invites the re-approval that puts a second copy in someone's
 * channel. There is nothing left here to reword.
 */
export type { DeliveryOutcome } from "@pubrick/shared";

/**
 * Spec §2.4's five status colors, mapped from every outcome that exists.
 * Seven values, five colors, no sixth palette (constitution).
 *
 * `queued`/`publishing` share `scheduled`'s blue — their own translated labels
 * are unaffected, only the color. `unknown` is the one use of `review`'s brick
 * on these screens, and it is the right one: `review` is the color of
 * something waiting on a human, and an unknown outcome is resolved by a person
 * opening the channel and looking. It is deliberately NOT `failed`'s red and
 * NOT `published`'s green, because it is neither.
 */
export const DELIVERY_BADGE_STATUS: Record<DeliveryOutcome, StatusBadgeStatus> = {
  pending: "draft",
  scheduled: "scheduled",
  queued: "scheduled",
  publishing: "scheduled",
  published: "published",
  failed: "failed",
  unknown: "review",
};

/**
 * The same five colors for the draft's own lifecycle. `approved` is the blue
 * of work in flight; `rejected` is the grey of something that will not happen,
 * the same grey `lib/runs.ts` gives a cancelled run.
 */
export const CONTENT_BADGE_STATUS: Record<ContentStatus, StatusBadgeStatus> = {
  draft: "draft",
  approved: "scheduled",
  rejected: "draft",
  published: "published",
  failed: "failed",
};

/**
 * Statuses from which the server is expected to move this row on its own,
 * soon, with no further human action — i.e. where a screen showing it has to
 * keep asking.
 *
 * `scheduled` is deliberately NOT one of them even though it will change
 * eventually: its due time can be days away, and polling every two seconds
 * until then is a request loop, not a live screen. `pending` is waiting for a
 * human, and `published`/`failed` are over.
 */
const IN_FLIGHT_ADAPTATION_STATUSES = [
  "queued",
  "publishing",
] as const satisfies readonly AdaptationStatus[];

export function isAdaptationInFlight(status: AdaptationStatus): boolean {
  return (IN_FLIGHT_ADAPTATION_STATUSES as readonly AdaptationStatus[]).includes(status);
}

export function hasAdaptationInFlight(
  adaptations: readonly { status: AdaptationStatus }[],
): boolean {
  return adaptations.some((a) => isAdaptationInFlight(a.status));
}

/**
 * How often the queue re-reads the content list while a post is being
 * delivered.
 *
 * Slower than the item screen's poll, and for the reason `lib/runs.ts` gives
 * for the open-runs strip: this is a LIST, watched by everyone with the main
 * screen open, while the item screen is watched by the one person who just
 * pressed the button.
 */
export const CONTENT_LIST_POLL_INTERVAL_MS = 5000;
