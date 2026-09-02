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
 * The sentinel the worker writes into `adaptations.last_error` when a send's
 * outcome was never learned (`PublishService.recordUnknownOutcome`).
 *
 * It is a string match because it has to be: the distinction lives in the
 * `publications` row's `unknown` status, and no content endpoint ships that
 * column — `ADAPTATION_COLUMNS.externalUrl` in the api's content repository is
 * a subquery filtered to `status = 'published'`, so the only trace of an
 * unknown outcome that reaches a browser is this prefix. The right fix is an
 * `outcome` field on the adaptation DTO; until that exists, this constant is
 * the coupling, and `adaptations.test.ts` pins it against the worker source so
 * a reworded sentence there fails a test here instead of silently turning
 * every unknown outcome back into a plain failure.
 */
export const UNKNOWN_OUTCOME_PREFIX = "DELIVERY OUTCOME UNKNOWN:";

/**
 * What actually happened to one channel's post — the adaptation's own status,
 * except that a `failed` one carrying the sentinel is not a failure.
 *
 * The adaptation column has no `unknown` state and cannot get one: `failed` is
 * its only terminal-and-not-published value, and the worker's own docstring
 * says the publications row is where the distinction lives. So the SCREEN
 * carries the sixth value the column does not, because rounding "we do not
 * know" to "it failed" is the thing this whole distinction exists to stop.
 */
export type DeliveryOutcome = AdaptationStatus | "unknown";

export function isUnknownOutcome(lastError: string | null): boolean {
  return lastError?.startsWith(UNKNOWN_OUTCOME_PREFIX) ?? false;
}

export function deliveryOutcome(adaptation: {
  status: AdaptationStatus;
  lastError: string | null;
}): DeliveryOutcome {
  return adaptation.status === "failed" && isUnknownOutcome(adaptation.lastError)
    ? "unknown"
    : adaptation.status;
}

/**
 * Spec §2.4's five status colors, mapped from every outcome that exists. Six
 * values, five colors, no sixth palette (constitution).
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
