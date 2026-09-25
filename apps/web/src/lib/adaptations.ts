import type {
  AdaptationStatus,
  ContentStatus,
  DeliveryOutcome,
  PublishFailureReason,
} from "@pubrick/shared";
import { SCHEDULED_DISPATCH_WINDOW_SECONDS } from "@pubrick/shared";
import type { StatusBadgeStatus } from "@/components/ui/status-badge";

/**
 * What actually happened to one channel's post: the api's own
 * `deliveryOutcome` field, re-exported so the badge map below is keyed on the
 * same union the response carries.
 *
 * `@pubrick/shared` derives it as `[...ADAPTATION_STATUSES, "unknown"]`, so a
 * status added to the column arrives in this union and `DELIVERY_BADGE_STATUS`
 * below stops compiling until somebody picks its color. The seven values and
 * what each of them means are documented there; the one this screen exists to
 * get right is `unknown`, a send whose answer never came back, which is neither
 * a success nor a failure.
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
 * The two lifecycles the content screens render, and the colors they wear.
 *
 * The lists are `@pubrick/shared`'s and are re-exported, not copied. They were
 * copies — first inline in `content/page.tsx` and `content/[id]/page.tsx`, then
 * once here — on the grounds that this package has no database dependency and
 * must not grow one for a string union. That is still true and is no longer a
 * reason to write them twice: they live in the package every screen here
 * already imports, beside the wire types they have to agree with.
 */
export {
  ADAPTATION_STATUSES,
  type AdaptationStatus,
  CONTENT_STATUSES,
  type ContentStatus,
} from "@pubrick/shared";

/**
 * The design-system spec's §2.4 five status colors, mapped from every outcome that exists.
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
  manual_ready: "review",
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
 *
 * `partially_published` takes `review`'s brick, for the reason `unknown` does
 * above: it is the colour of something waiting on a person. It is deliberately
 * NOT `approved`'s blue — nothing is in flight, which is exactly the lie this
 * status was added to end — nor `published`'s green, which would claim a post
 * that is half missing, nor `failed`'s red, which would claim one that never
 * went out at all.
 */
export const CONTENT_BADGE_STATUS: Record<ContentStatus, StatusBadgeStatus> = {
  draft: "draft",
  approved: "scheduled",
  partially_published: "review",
  rejected: "draft",
  published: "published",
  failed: "failed",
  archived: "draft",
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

/**
 * HAS THIS SLOT COME AND GONE WITH NOTHING DELIVERED — asked of the browser's
 * clock, which is the right clock here (nothing is being decided; the question
 * is whether the time THIS reader is looking at has passed for them) and the
 * wrong one to alarm off without a margin.
 *
 * THE MARGIN IS THE DISPATCH WINDOW, and it is `@pubrick/shared`'s number
 * rather than a few minutes picked here: an approved post is a pg-boss job with
 * `startAfter = scheduled_at`, and the row is `scheduled` until a handler
 * writes `markPublishing` — a poll away at best, and an expiry plus a supervise
 * interval away if the host that took the job died before that write. Without
 * it, opening the item page seconds after a perfectly healthy slot painted a
 * `role="alert"` accusing the system of an outage, and a laptop clock an hour
 * fast painted every slot in the next hour the same way.
 *
 * Deliberately NOT the worker's own bound: `PUBLISH_MAX_LATENESS_HOURS` decides
 * whether a post still goes out, on the database's clock, and it is hours where
 * this is minutes. This says only "long enough that something should have
 * happened by now".
 */
export function isScheduleOverdue(scheduledAt: string, now: number = Date.now()): boolean {
  return now - new Date(scheduledAt).getTime() > SCHEDULED_DISPATCH_WINDOW_SECONDS * 1000;
}

/**
 * WHY A DELIVERY FAILED, in the reader's language — one sentence per member of
 * `PUBLISH_FAILURE_REASONS`.
 *
 * The worker writes two things about a failure: a CODE, closed and typed, and
 * `last_error`, free text it composes in English. Until now the screens printed
 * the text. That is a log line — it names `scheduled_at` as a raw UTC instant,
 * it says "adapter" and "claim", and it is English on a product that ships in
 * four languages — so the screen now speaks from the CODE, and the prose is
 * kept for the one class where the words are not ours to write: a platform's
 * own refusal.
 *
 * This is the same lesson as the module docstring at the top of this file, one
 * column over: behaviour keyed off a worker sentence is behaviour a rewording
 * silently changes. Nothing here reads `last_error` to decide anything.
 */
const FAILURE_REASON_KEYS = {
  schedule_missed: "failureReason.scheduleMissed",
  no_adapter: "failureReason.noAdapter",
  credentials_unreadable: "failureReason.credentialsUnreadable",
  credentials_missing: "failureReason.credentialsMissing",
  credentials_invalid: "failureReason.credentialsInvalid",
  platform_rejected: "failureReason.platformRejected",
  rejected_before_send: "failureReason.rejectedBeforeSend",
  retries_exhausted: "failureReason.retriesExhausted",
  send_abandoned: "failureReason.sendAbandoned",
  /**
   * NOT A SENTENCE OF ITS OWN, and deliberately the one the screens already
   * say. A row coded `outcome_unknown` always carries an `unknown` receipt, so
   * the api answers `deliveryOutcome: "unknown"` for it and both screens take
   * the resolver branch — the paragraph that names the channel and the buttons
   * that settle it. Pointing this member at that same key keeps the map total
   * without inventing a tenth wording for a state that already has one, and
   * makes it impossible for the two to drift into saying different things.
   */
  outcome_unknown: "unknownOutcome",
} as const satisfies Record<PublishFailureReason, string>;

/** The `Content` message key for one failure reason. Total by construction. */
export function failureReasonKey(reason: PublishFailureReason): string {
  return FAILURE_REASON_KEYS[reason];
}

/** What `failureSentence` needs of a translator: `useTranslations("Content")`. */
export type ContentTranslator = (key: string, values?: Record<string, string | number>) => string;

/** The parts of a failed adaptation the sentence is built from. */
export type FailedDelivery = {
  failureReason: PublishFailureReason | null;
  lastError: string | null;
  lateBySeconds: number | null;
  attemptCount: number;
};

/**
 * HOW LATE, as the reader sees it: tenths of an hour, ROUNDED UP.
 *
 * Up rather than to nearest, for the reason the worker rounds its own frozen
 * sentence up: the number is a claim about how long somebody's post sat
 * unsent, and rounding down understates it — a post 6.04 h past a 6 h bound
 * would read "6.0 h", which is the bound itself and reads as "only just".
 */
function lateHours(seconds: number): string {
  return (Math.ceil((seconds / 3600) * 10) / 10).toFixed(1);
}

/**
 * The one sentence a failed delivery shows, or `null` when it has nothing to
 * say.
 *
 * THREE ANSWERS, in falling order of how much each knows — the shape
 * `errorMessage` uses for a refused request, for the same reason:
 *
 * 1. THE CODE, turned into a sentence in the reader's language, with the
 *    numbers the api computed (the lateness frozen at the refusal, the attempt
 *    count) interpolated. This is every row that failed after the column
 *    shipped.
 * 2. `last_error`, for a row that failed BEFORE it — the one population the
 *    column is null for. English prose, and better than a blank line.
 * 3. Nothing, for a failure that recorded neither.
 *
 * `channel` is the label the calling screen already resolved; the sentences
 * that send a reader to the brand screen name it, because "reconnect the
 * channel" is not an instruction anybody can follow without knowing which one
 * — and the brand screen is where channels are added, edited and reconnected
 * (`app/[locale]/brands/[id]/page.tsx`). Not Settings, which holds appearance,
 * the AI provider, the account and the workspace, and has no channel on it.
 */
export function failureSentence(
  delivery: FailedDelivery,
  t: ContentTranslator,
  channel: string,
): string | null {
  const { failureReason: reason, lastError, lateBySeconds, attemptCount } = delivery;
  if (reason === null) return lastError;
  switch (reason) {
    case "schedule_missed":
      // A slot the api could not measure — a pre-column row re-failed, or a
      // receipt that went missing — still gets the reason, without the number.
      return lateBySeconds !== null && lateBySeconds > 0
        ? t(FAILURE_REASON_KEYS.schedule_missed, { hours: lateHours(lateBySeconds) })
        : t("failureReason.scheduleMissedNoHours");
    case "platform_rejected":
      return lastError
        ? t(FAILURE_REASON_KEYS.platform_rejected, { error: lastError })
        : t("failureReason.platformRejectedNoText");
    // THE SAME SHAPE, THE OTHER REFUSER. The words are still not ours to
    // paraphrase — a length limit, a gateway's "no" — but the sentence around
    // them must not say the platform wrote them, because the platform never saw
    // the post.
    case "rejected_before_send":
      return lastError
        ? t(FAILURE_REASON_KEYS.rejected_before_send, { error: lastError })
        : t("failureReason.rejectedBeforeSendNoText");
    case "retries_exhausted":
      // "SO FAR", because this is a LIFETIME counter. `attempt_count` is never
      // reset — `approve` carries it forward and increments, the delivery
      // resolver increments, `markFailed` bumps it once per attempt — so a post
      // approved three times over a week reads the total, including attempts
      // that ended in a credential failure or a platform refusal. The sentence
      // counts attempts on this post rather than attempts in this run, and says
      // so; a number scoped to one approval would need a column nothing writes.
      return t(FAILURE_REASON_KEYS.retries_exhausted, { attempts: attemptCount });
    case "credentials_missing":
      return t(FAILURE_REASON_KEYS.credentials_missing);
    default:
      return t(FAILURE_REASON_KEYS[reason], { channel });
  }
}

/**
 * How many LATER pages one tick may re-read, beside page 1.
 *
 * The refresh set is bounded by in-flight work — a page with nothing moving on
 * it is not re-read at all — and that was once argued to be enough on its own.
 * It is not: nothing caps deliveries. `MAX_CONCURRENT_RUNS` caps GENERATION
 * runs (an admission cap on spend), while a page is held unsettled by
 * ADAPTATION status, and approving thirty posts puts thirty adaptations in
 * flight across as many pages as they land on. `PUBLISH_QUEUE_OPTIONS` then
 * keeps a failing one there for up to `retryDelayMax` — an hour — between
 * attempts.
 *
 * So the tick is capped instead, at this plus page 1. The number is small
 * because the api's `pg.Pool` holds ten connections for the whole
 * installation — sign-in and every other screen included — and this fan-out
 * goes out simultaneously, once every five seconds, PER TAB. The set is walked
 * round-robin rather than always taking the oldest, so a page beyond the cap
 * is re-read a tick or two later rather than never.
 */
export const MAX_REFRESHED_LATER_PAGES = 3;
