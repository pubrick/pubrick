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
 * - `ChannelsRepository.create`'s "Pubrick cannot publish to X yet" — the
 *   channel form's platform list is `PLATFORM_IDS` with everything outside
 *   `PUBLISHABLE_PLATFORM_IDS` disabled and labelled `platformUnsupported`, so
 *   the picker cannot submit one. A request that names an unpublishable
 *   platform was hand-built, and the sentence already names the platform, which
 *   a nullary code could not.
 *
 * Adding one later is additive on the wire and a compile error in the web's
 * `ERROR_MESSAGE_KEYS`, which is the point of the record being total.
 */
export const API_ERROR_CODES = [
  "client_review_role_required",
  "client_review_required",
  "client_review_link_invalid",
  "client_review_link_closed",
  "client_review_rate_limited",
  "client_review_invalid",
  "private_source_owner_required",
  "private_source_not_configured",
  "private_source_not_connected",
  "private_source_cooldown",
  "private_source_access_denied",
  "private_source_session_changed",
  "private_source_duplicate",
  "telegram_login_cooldown",
  "telegram_login_expired",
  "telegram_login_invalid",
  "telegram_login_busy",
  "telegram_login_unavailable",
  "recheck_busy",
  "recheck_empty",
  "recheck_preview_stale",
  // ── content: the row is gone ──────────────────────────────────────────────
  /** The post does not exist in this org (or no longer does). */
  "content_not_found",
  "claim_review_body_changed",
  "claim_review_not_editable",
  "claim_review_no_search_key",
  "claim_review_no_ai_key",
  "claim_correction_stale",
  "claim_correction_not_found",
  "claim_correction_ineligible",
  "claim_correction_no_credential",
  "claim_correction_limit_reached",
  "claim_correction_failed",
  "claim_correction_timed_out",
  "editorial_note_stale",
  "draft_revision_stale",
  "draft_revision_incomplete",
  "draft_revision_note_not_found",
  "draft_revision_needs_ai_draft",
  "draft_revision_limit_reached",
  "draft_revision_no_credential",
  "draft_revision_timed_out",
  "draft_revision_failed",
  "draft_revision_proposal_not_found",
  "publication_not_found",
  "publication_comments_unavailable",
  "publication_comments_refresh_cooldown",
  "metrics_refresh_cooldown",
  "metrics_unavailable",
  "content_media_unsupported",
  "content_media_invalid",
  "content_media_too_large_for_bluesky",
  "content_media_caption_too_long",
  "content_media_pinned",
  "content_image_position_invalid",
  "content_image_body_conflict",
  "content_image_not_found",
  "content_images_changed",
  "content_image_crop_invalid",
  "content_images_need_review",
  "media_invalid",
  "media_not_found",
  "media_unavailable",
  "media_in_use",
  "media_video_pinned",
  "media_cover_pinned",
  "media_cover_changed",
  "media_cover_video_selected",
  "media_generation_limit",
  "media_generation_busy",
  "media_generation_failed",
  "cover_requires_google_key",
  "inline_images_require_google_key",
  /** Public syndication is opt-in; the feed may have been disabled. */
  "feed_not_found",
  /** A feed entry must be a titled post already delivered somewhere. */
  "feed_item_not_ready",
  /** The channel override's row is gone — usually its channel was deleted. */
  "adaptation_not_found",
  "version_not_found",
  "version_changed",

  // ── content: the text is pinned ───────────────────────────────────────────
  // One code per pinned status rather than one code plus a status argument:
  // "Approved content cannot be edited" is a lie about an item the UI labels
  // "Published", which is why the api's message record is keyed by status in
  // the first place.
  "content_pinned_approved",
  "content_pinned_published",
  "content_archived",
  "content_archive_delivery_active",
  "content_topic_unlinked",
  "content_topic_veto_not_draft",
  "content_topic_veto_has_delivery_history",
  "content_delete_requires_archive",
  "content_delete_has_delivery_history",
  "content_delete_has_generation_history",
  "content_delete_not_draft",
  "adaptation_pinned_scheduled",
  "adaptation_pinned_manual_ready",
  "adaptation_pinned_queued",
  "adaptation_pinned_publishing",
  "adaptation_pinned_published",

  // ── content: the decision cannot be made ──────────────────────────────────
  /** Approve or reject on a post that is already live somewhere. */
  "content_already_published",
  "approval_retraction_not_approved",
  "approval_retraction_delivery_started",
  /**
   * REJECT ON A POST THAT IS PART LIVE AND PART OVER — a different refusal from
   * the one above, and a separate code because one sentence cannot be true of
   * both.
   *
   * `content_already_published` says "this post has already been published",
   * which is a lie beside a badge reading "Partly published", and it says
   * approve is refused too — when approve is exactly the action that works
   * here: it re-sends the halves that failed and cannot touch the live one.
   * This code's sentence names both the state and the two things left to do
   * (design §4.2: leave it, or send the rest).
   *
   * ONLY REJECT EMITS IT, and only when nothing is outstanding. With a send
   * still in flight reject is ACCEPTED and cancels it
   * (`ContentRepository.reject`), so there is no refusal to name; approve goes
   * through the item's own status, which for such a post is never `published`.
   */
  "content_partially_published",
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
  /**
   * APPROVE MET A DELIVERY NOBODY CAN SPEAK FOR, and had nothing else left to
   * send.
   *
   * An adaptation whose last finished attempt ended `unknown` may already be
   * live in someone's channel — the request left, the answer did not — so
   * `approve` skips it rather than re-sending it, PER ROW: a four-channel post
   * with one unknown half still re-sends the halves that provably failed. This
   * is the refusal for the case where the skip leaves nothing at all to
   * enqueue, because a 200 that did no work is this project's own named defect
   * class (`schedule_already_queued` above records the last time it shipped).
   *
   * The way out is not this endpoint. Nothing else in the product moves an
   * adaptation off `failed`+unknown, so the refusal ships with its resolver:
   * the person opens the channel, sees whether the post is there, and says so
   * (`POST /api/content/:id/adaptations/:adaptationId/delivery`).
   */
  "delivery_outcome_unknown",
  /** The reviewed draft stays frozen until its live Telegram photo is resolved. */
  "partial_telegram_unresolved",
  /** A send claim is still in flight; rejecting it could hide a live post. */
  "delivery_in_flight",
  /**
   * The resolver, on a delivery whose outcome is NOT in doubt.
   *
   * A second code rather than an argument on the first, because the codes here
   * are nullary and named by state: one code cannot mean both "in doubt" and
   * "not in doubt". It is also the refusal two clicks on the same button race
   * for — the loser reads the outcome under the adaptation's row lock, finds it
   * settled, and is told so instead of meeting
   * `publications_one_published_per_adaptation` as a raw 23505.
   */
  "delivery_outcome_already_known",
  "manual_schedule_unsupported",
  "manual_publication_pending",
  "manual_publication_not_ready",
  /** A schedule time that is not in the future. */
  "schedule_in_past",
  "schedule_too_close",
  "schedule_changed",
  "schedule_not_scheduled",
  "schedule_parent_not_ready",
  "schedule_has_history",
  /**
   * A NEW TIME FOR A POST THAT IS ALREADY ON ITS WAY — the two refusals that
   * replaced a 200 which changed nothing.
   *
   * `ContentRepository.approve` re-targets an item's `pending`, `failed` and
   * `scheduled` deliveries and deliberately leaves `queued` and `publishing`
   * alone: re-enqueueing either cancels a live job for no gain, which is the
   * right call and stays the right call. What was wrong was the answer. A
   * reader who set a new time on an item every one of whose channels was
   * already queued got 200 and a screen that showed the time they picked, while
   * the post went out at the old one — this project's own named defect class, an
   * early exit reporting the same success as real work.
   *
   * It refuses whenever the schedule cannot reach EVERY channel, rather than
   * moving the channels it can: one post going out at two different times is
   * not what anybody asked for, and it is a state the reader would have to
   * discover rather than be told.
   *
   * TWO CODES, because the two states are different facts with different things
   * to do about them, and one sentence cannot be true of both — the same
   * argument the pinned-status codes above make.
   *
   * - `schedule_already_queued`: the delivery is committed but nothing has been
   *   sent. There IS a recovery and the sentence names it — `reject` cancels the
   *   queued job and puts the channel back to `pending`, so rejecting and
   *   approving again applies the new time.
   * - `schedule_already_publishing`: a worker is talking to the platform right
   *   now. The post may already be live, so the sentence offers no recovery and
   *   tells the reader to wait for the attempt to land. Rejecting here would
   *   cancel a retry chain without unsending anything.
   *
   * Only a SCHEDULE is refused. "Publish now" on the same item still answers
   * 200, and honestly: a queued or publishing channel is already doing exactly
   * what that request asks for, so nothing about the reader's belief is wrong.
   */
  "schedule_already_queued",
  "schedule_already_publishing",

  // ── content: the model was asked to revise a selection ────────────────────
  /**
   * SIX REFUSALS FOR ONE ROUTE, and the split is not tidiness: this is the
   * first route a person can make spend money repeatedly, by hand, and each of
   * these tells them a different thing to do about it. Folding them into one
   * sentence would be the "one honest sentence for four different faults"
   * mistake this file's own comments argue against — and here the reader's
   * next action differs every time: wait an hour, generate a draft first, go
   * to Settings, press again, shorten the post, or nothing at all.
   *
   * All 409 rather than 429/503, because `refusalBody`'s status set is closed
   * at 400/403/404/409 for its own documented reasons, and every one of these
   * is the same kind of event: the request was well formed and the server will
   * not do it in the state it is in.
   */
  /**
   * The hour's allowance of billed refine calls is spent. Its number is
   * `MAX_REFINE_CALLS_PER_HOUR`, not an argument — the same arrangement
   * `run_limit_reached` has, and the same `ERROR_MESSAGE_VALUES` entry.
   */
  "refine_limit_reached",
  "readapt_limit_reached",
  "readapt_no_credential",
  "readapt_timed_out",
  "readapt_failed",
  "readapt_proposal_not_found",
  "readapt_source_changed",
  /**
   * The draft has no `ai` `full` version row at the item level: nobody has
   * generated this text, so there is no anchor for the publish gate's deletion
   * clause and no honest badge for a body a model has touched part of. Refined
   * anyway, the product would either credit the model's sentence to the person
   * or refuse the draft for ever; both re-open a settled surface for a use the
   * flagship path does not need. Deliberately refused — see the increment's
   * plan, §5.
   */
  "refine_needs_ai_draft",
  /**
   * The organisation has stored no API key at all, so there is nothing to make
   * the call with. Separated from `refine_failed` because it is the one the
   * reader can act on — it sends them to Settings — and a generic sentence
   * would send them nowhere.
   */
  "refine_no_credential",
  /** The call did not answer inside its budget. Nothing was staged. */
  "refine_timed_out",
  /**
   * Every other classified model failure — a rejected key, a model that does
   * not exist, a refusal, an answer that would not parse. The provider's own
   * words are deliberately not forwarded: they quote the submitted API key
   * back (see `AI_TEST_FAILURES`), and Settings' Test button is where a
   * diagnosis of the key belongs.
   */
  "refine_failed",
  /**
   * The proposal is fine and the body it would make is not: spliced in, the
   * result exceeds `MAX_BODY_LENGTH`. Checked at propose so a reply past the
   * limit is not staged as a proposal that could never be accepted, and again
   * at Accept, because the body can grow in between.
   */
  "refine_too_long",

  // ── content: the proposal is accepted, discarded, or refused ──────────────
  /**
   * There is no such staged proposal on this draft — it was accepted,
   * discarded, or superseded by a later press, each of which deletes the row
   * whole. Also the answer for a proposal id belonging to another org, and for
   * one staged against a DIFFERENT draft of this org: the second is not
   * pedantry, since that proposal's anchor and offsets were measured against
   * another body and applying them here would splice the model's words into a
   * post nobody asked it about.
   *
   * 404 rather than 403, this suite's tenancy convention throughout: a stranger
   * learns nothing about what exists. And its own code rather than
   * `content_not_found`, because the two send the reader to different places —
   * the post is right there in front of them; it is the suggestion that is
   * gone.
   */
  "refine_proposal_not_found",
  /**
   * Accepting would record words a PERSON wrote as the model's.
   *
   * A merged sentence can absorb characters from outside the replaced range — a
   * human's `Note: ` prefix, a list marker, the sentence a proposal without a
   * terminator fuses with. Where those came from text no model wrote, the
   * `fragment` row this Accept would file says a model wrote them: the lens
   * stops dimming them and the badge reads "AI-drafted" over the author's own
   * line. Refused rather than approximated, and the recovery is one
   * re-selection — selecting the WHOLE sentence is accepted, because then
   * nothing of theirs survives into the merged unit.
   */
  "refine_would_launder",
  /**
   * The text the suggestion was written for is no longer anywhere in the
   * draft, so there is nothing to splice it into.
   *
   * Only when there is NO occurrence left: the anchor is re-located at the
   * occurrence nearest where it was, never by hashing the whole body, because
   * an edit three paragraphs away leaves the selection exactly where it was and
   * refusing there throws away a call somebody paid for.
   */
  "refine_anchor_lost",

  // ── channels named by a request ───────────────────────────────────────────
  /** One of the channel ids is not this brand's. Shared by content and runs. */
  "channels_not_in_brand",
  /** The channel does not exist in this org (or no longer does). */
  "channel_not_found",
  /**
   * The channel's stored credentials will not decrypt under any key this
   * instance has — `APP_ENCRYPTION_KEY` was changed under a stored row, or the
   * ciphertext was tampered with.
   *
   * A 409, not a 500 and not a `VerifyResult`. Not a 500 because nothing is
   * broken about the request: the row exists, the caller may read it, and there
   * is a specific, actionable thing to do about it. Not a `{ok: false, reason}`
   * like the platform's own verdicts, because it is not a verdict ABOUT THE
   * PLATFORM at all — it is raised before any publisher is consulted, and
   * `VerifyResult.reason` is free English prose that no screen can translate.
   *
   * This is `AiTestFailure`'s `unreadable_key` for the other credential store:
   * one event, one cause, one thing to do, said in the closed set each surface
   * already reads.
   */
  "unreadable_credentials",

  // ── runs ──────────────────────────────────────────────────────────────────
  "run_not_found",
  "source_fetch_failed",
  "source_response_too_large",
  "source_unreadable",
  "topic_not_found",
  "news_item_not_found",
  "news_item_dismissed",
  "topic_not_approved",
  "topic_blocked",
  "topic_changed",
  "topic_suggestions_cooldown",
  "topic_planning_disabled",
  "topic_planning_cooldown",
  "autopilot_trigger_cooldown",
  "brand_not_found",
  "brand_import_no_google_key",
  "brand_import_limit_reached",
  "brand_import_stale",
  "brand_import_failed",
  "brand_import_unreadable",
  "knowledge_not_found",
  "knowledge_batch_owner_required",
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
  // ── planned calendar generation ──────────────────────────────────────────
  "calendar_slot_not_found",
  "memorable_date_not_found",
  "calendar_slot_started",
  "calendar_time_in_past",
  "calendar_topic_linked",
  "calendar_topic_already_planned",
  "calendar_topic_changed",
  "topic_has_calendar_slots",

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
 * The statuses a coded refusal is allowed to use, and the name Nest gives
 * each one.
 *
 * A closed map rather than a lookup, so an unlisted status does not compile.
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
  410: "Gone",
  429: "Too Many Requests",
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
