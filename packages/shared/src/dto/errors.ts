/**
 * WHY A REFUSAL CARRIES A CODE.
 *
 * The web renders a 4xx body's sentence verbatim, on purpose: a 4xx is the
 * server saying something specific and actionable about THIS request, and
 * collapsing it into a generic apology throws away the only thing that tells
 * the reader what to do next (`errorMessage`, apps/web/src/lib/api.ts). That
 * decision is right for the audience it was written for — a developer with a
 * network tab open — and wrong for the other one: those sentences are English,
 * and this product ships in four languages. A test guards message parity across
 * `en`, `es`, `ru` and `pt` while a Spanish user reads "Approved content cannot
 * be edited; reject it first".
 *
 * They also speak a different vocabulary than the screens do. The API says
 * "content item" where every screen says "post" — so the one moment the product
 * breaks its own one-noun-for-one-thing rule is the moment something has
 * already gone wrong.
 *
 * This is `AI_TEST_FAILURES`' and `RUN_FAILURES`' rule applied to the third
 * place the server talks to a browser, and it is deliberately the SAME shape:
 * a closed set of codes the web maps to translated sentences. What is different
 * is what happens to the prose. For a provider failure the sentence is dropped
 * on the floor, because a provider's error text quotes the submitted API key
 * back. Here the sentence is OURS — written in this repository, containing no
 * secret by construction — so it stays in the body beside the code. It is what
 * a developer reads in a network tab, what a public-API consumer gets, and what
 * a client too old to know the code can still show (see `errorMessage`).
 *
 * ARGUMENTS DO NOT TRAVEL. Every code below is nullary, exactly as
 * `too_long_for_channel` is: nothing on the wire carries a channel name, a
 * limit or a status. Where a sentence needs a number — `run_limit_reached` —
 * the number is `MAX_CONCURRENT_RUNS`, which both sides already import from
 * this package, and which the web app already names on its own empty state.
 * Where a sentence needs a status, the STATUS IS IN THE CODE
 * (`content_pinned_approved` vs `content_pinned_published`), which keeps the
 * api's existing per-status message records exhaustive-by-construction and
 * keeps the web's map total over the union. A code that carried arguments would
 * need a second, unvalidated shape on the wire and a translator that trusted
 * it; four extra members of a closed set cost nothing and cannot drift.
 */

/**
 * Every refusal a person using this product can actually provoke.
 *
 * Membership is a judgement about REACHABILITY, not about tidiness. Three
 * refusals are deliberately NOT here and keep their bare English sentence:
 *
 * - `ContentRepository.list`'s unknown `?status=` and `RunsRepository.list`'s
 *   unknown `?state=` — the only clients that send those are a `<select>` built
 *   from the enum and this repository's own tests. A caller that hand-writes a
 *   query string is a developer, and a developer is who the sentence already
 *   names the valid values for.
 * - `ParseAiProviderPipe`'s "Unknown provider" — same: the settings screen's
 *   provider list IS `AI_PROVIDERS`, so reaching it means building the URL by
 *   hand.
 *
 * Adding one later is additive on the wire and a compile error in the web's
 * `ERROR_MESSAGE_KEYS`, which is the point of the record being total.
 */
export const API_ERROR_CODES = [
  // ── content: the row is gone ──────────────────────────────────────────────
  /** The post does not exist in this org (or no longer does). */
  "content_not_found",
  /** The channel override's row is gone — usually its channel was deleted. */
  "adaptation_not_found",

  // ── content: the text is pinned ───────────────────────────────────────────
  // One code per pinned status rather than one code plus a status argument:
  // "Approved content cannot be edited" is a lie about an item the UI labels
  // "Published", which is why the api's message record is keyed by status in
  // the first place.
  "content_pinned_approved",
  "content_pinned_published",
  "adaptation_pinned_scheduled",
  "adaptation_pinned_queued",
  "adaptation_pinned_publishing",
  "adaptation_pinned_published",

  // ── content: the decision cannot be made ──────────────────────────────────
  /** Approve or reject on a post that is already live somewhere. */
  "content_already_published",
  /** Approve on a post whose every channel has since been deleted. */
  "content_no_channels_left",
  /**
   * The publish gate: nobody has read this AI-written draft, and editing the
   * body WOULD clear the refusal.
   */
  "unread_ai_draft",
  /**
   * The same gate where editing cannot clear it, because no complete AI version
   * of the body was ever recorded to judge an edit against. Two codes, because
   * one sentence cannot be true of both shapes — the same reason the api keeps
   * two messages.
   */
  "unread_ai_draft_open_only",
  /** A schedule time that is not in the future. */
  "schedule_in_past",

  // ── channels named by a request ───────────────────────────────────────────
  /** One of the channel ids is not this brand's. Shared by content and runs. */
  "channels_not_in_brand",

  // ── runs ──────────────────────────────────────────────────────────────────
  "run_not_found",
  "brand_not_found",
  /** Generating for a brand that has nothing to publish to. */
  "brand_has_no_channels",
  /** The admission cap. Its number is `MAX_CONCURRENT_RUNS`, not an argument. */
  "run_limit_reached",
  "run_not_cancellable_succeeded",
  "run_not_cancellable_failed",
  "run_not_cancellable_cancelled",
  "run_not_dismissable_queued",
  "run_not_dismissable_running",

  // ── credentials ───────────────────────────────────────────────────────────
  /** Test or Remove against a provider whose key is no longer stored. */
  "ai_credential_not_found",

  // ── the session's organization ────────────────────────────────────────────
  /**
   * `ActiveOrgGuard` refusing a request whose session names no organization —
   * the one refusal the web used to identify by SNIFFING the English sentence
   * of a 403 (`/no active organization/i`, `apps/web/src/lib/api.ts`).
   *
   * A sniff is not a contract: it reads a sentence written for a developer's
   * network tab as if it were a machine field, so rewording that sentence —
   * or translating it, which is the whole direction this product is going —
   * silently turns "send this person to onboarding" into "show them a 403".
   * The web branches on this to REDIRECT, not merely to phrase, so the failure
   * would not have been a worse sentence; it would have been an account stuck
   * on a screen it can never load.
   *
   * The guard's OTHER 403 — a session pointing at an organization the caller
   * is not a member of — deliberately stays uncoded. The web replaces every
   * non-org 403's sentence with one of its own (`forbidden`, a code no server
   * sends), so a code there would name a refusal the reader is already
   * answered about without one.
   */
  "no_active_organization",

  // ── the validation boundary ───────────────────────────────────────────────
  /**
   * A body zod refused.
   *
   * ONE code for the whole boundary, and that is the decision the wire-field-
   * name problem forced. A user must never read "scheduledAt: scheduledAt must
   * be in the future", and there were two ways to stop it: reformat the pipe's
   * sentence, or map it in the web. Neither works alone — reformatting leaves
   * zod's own English ("String must contain at most 4096 character(s)"), and
   * mapping needs one web entry per field per rule, which drifts the instant a
   * schema changes and cannot be made total.
   *
   * So the split is by reachability instead. The one validation refusal a user
   * can actually provoke through the shipped UI — a schedule time in the past,
   * which no date picker can prevent because the clock keeps moving between
   * pick and submit — stopped being validation at all: it is a clock-dependent
   * predicate, not a shape predicate, so it moved into the domain and became
   * `schedule_in_past`. Everything else zod can refuse is either unreachable
   * (the textareas enforce `MAX_BODY_LENGTH`/`MAX_BRIEF_LENGTH` with
   * `maxLength`, the selects are built from the enums) or a hand-built request,
   * and both of those get this one honest sentence while the developer keeps
   * the full field-qualified array in `message`.
   */
  "invalid_request",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Is this string one of the codes? Guards a value read off the wire. */
export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && (API_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * The four statuses a coded refusal is allowed to use, and the name Nest gives
 * each one.
 *
 * A closed map rather than a lookup, so `refusalBody(410, …)` does not compile.
 * The pairing matters because the api's helpers wrap these in the matching Nest
 * exception class: a body whose `statusCode` disagreed with the response's real
 * status would be a lie told in the one place a client goes to find out what
 * happened.
 */
const REFUSAL_STATUS_NAME = {
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
} as const;

export type RefusalStatus = keyof typeof REFUSAL_STATUS_NAME;

/**
 * The body every coded refusal is thrown with — Nest's own three fields, plus
 * the code.
 *
 * ADDITIVE on purpose. `statusCode`, `error` and `message` keep exactly the
 * values and the shape they had before codes existed, so a client that has
 * never heard of `code` — the web build in someone's cache, an API consumer's
 * script, a developer's network tab — sees no change at all.
 */
export type ApiErrorBody = {
  statusCode: RefusalStatus;
  error: string;
  message: string | string[];
  code: ApiErrorCode;
};

/**
 * Builds that body. Lives here, in the package both the api and the web import,
 * rather than in either of them: the web's tests drive `errorMessage` with
 * bodies built by this exact function, so the response the api throws and the
 * response the web is proved to understand cannot become two different shapes.
 */
export function refusalBody(
  statusCode: RefusalStatus,
  code: ApiErrorCode,
  message: string | string[],
): ApiErrorBody {
  return { statusCode, error: REFUSAL_STATUS_NAME[statusCode], message, code };
}
