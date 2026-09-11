import { z } from "zod";
import { normalizeNewlines } from "../provenance.js";
import { hasNulByte, NO_NUL_BYTE_MESSAGE } from "./text.js";

/**
 * DRAFT LIFECYCLE — the one declaration of it, for every package that stores,
 * validates or paints a content item's status.
 *
 * It lives in `@pubrick/shared` rather than beside the column it bounds because
 * a status is product vocabulary, not a database artefact, and every consumer
 * already depends on this package: `@pubrick/db` types `content_items.status`
 * with it AND builds that column's CHECK constraint from it, `apps/api` derives
 * its editable/pinned split by `Exclude`-ing from it, and `apps/web` — which
 * has no database dependency and must not grow one — keys its badge colors on
 * it. It used to be declared three times over, and the copy that mattered had a
 * comment saying it was a copy and no test comparing it to anything.
 *
 * `approved` means every adaptation was queued or scheduled.
 *
 * `partially_published` is where a fan-out STOPS when its channels disagree:
 * at least one is live, at least one never went, and NOTHING LEFT IN THE
 * SYSTEM WILL MOVE IT WITHOUT A PERSON. That last clause is the definition —
 * not "every delivery is over", which was this comment's first wording and is
 * false of one of the two shapes that reach here:
 *
 * - the fold's (`nextItemStatus` below): every delivery ended and they
 *   disagreed, e.g. `{published, failed}`;
 * - the canceller's (`ContentRepository.reject`): a person rejected a fan-out
 *   with a live channel and a send still outstanding, so the outstanding half
 *   was cancelled back to `pending` and the item written here BY HAND. That
 *   half is not over — it is waiting for the same person — and the fold
 *   deliberately does not claim otherwise.
 *
 * It sits beside `approved` because that is the status it replaces — an item
 * whose halves disagreed used to keep `approve`'s own value for ever, painted
 * in the blue of work in flight, with nothing left in the system that would
 * ever move it. It is a WAITING state, not a final one: a later delivery
 * recomputes the item, so a retry of the failed half promotes it to
 * `published` on its own.
 */
export const CONTENT_STATUSES = [
  "draft",
  "approved",
  "partially_published",
  "rejected",
  "published",
  "failed",
] as const;
export type ContentStatus = (typeof CONTENT_STATUSES)[number];

/** Per-channel delivery lifecycle. One declaration, for the reasons above. */
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
 * WHAT A CONTENT ITEM'S STATUS BECOMES once its deliveries have moved — the
 * ONE definition of the promotion rule, for every caller in every tier.
 *
 * A pure fold over an item's adaptation statuses. Three verdicts: `published`
 * when they all published, `failed` when they all failed, and
 * `partially_published` when every one of them is over and they disagreed.
 * `undefined` means "leave the item where it is": a fan-out with a delivery
 * still outstanding has not decided anything yet, and neither has an item with
 * no adaptations at all.
 *
 * "OVER" HERE MEANS `published | failed`, AND DELIBERATELY EXCLUDES `pending`,
 * which has no job behind it either (`OUTSTANDING_ADAPTATION_STATUSES` below).
 * The two are not the same question. This fold answers "what did the
 * DELIVERIES decide", and a `pending` row decided nothing: it is waiting for a
 * person, `approve` targets it, and one press sends it. So `{published,
 * pending}` returns `undefined` — the fold has no verdict about a fan-out a
 * person has still to finish, and inventing one would paint "this is how it
 * ended" over a post that is one click from going out.
 *
 * That leaves exactly one gap, and it has an owner rather than a widening
 * here: `reject` on a fan-out with a live channel cancels the outstanding half
 * back to `pending` and writes `partially_published` ITSELF, because the
 * person who pressed the button is what made the item partly published, not a
 * delivery. Widening this arm to admit `pending` instead is killed 3/3 by
 * `packages/db`'s fold/SQL matrix, which is the ratchet saying the same thing.
 *
 * IT LIVES IN THE RULE BOOK BECAUSE THREE CALLERS NEED IT AND THEY ARE NOT ONE
 * PROCESS. The worker's bookkeeping promotes an item when a delivery lands
 * (`recomputeItemStatus`, apps/worker/src/publish/publish.repository.ts); the
 * api promotes it when a person settles an unknown delivery by hand
 * (`ContentRepository.assertDelivery`). Two lock dances, one verdict — and a
 * verdict restated at each site is a verdict that will answer differently on
 * one screen, which is the same argument `deliveryOutcome` and
 * `bodyIsAiVerbatim` are computed once for.
 *
 * NOT A DATABASE FUNCTION, and that was considered. `runMigrations` is the
 * api's (`apps/api/src/main.ts`) and nothing else applies DDL, so a worker
 * deployed against a database that has not been migrated yet would throw
 * `42883` AFTER the platform call succeeded — stranding the claim and minting
 * exactly the `unknown` outcomes this rule exists to reduce, and inverting
 * `docs/self-hosting.md` §Upgrade's "worker first is always safe".
 *
 * THE EMPTY ARRAY IS LOAD-BEARING, not a courtesy. An item whose channels have
 * all been deleted has no adaptation left to speak for it, and `every` over an
 * empty array is `true` for ALL THREE arms — so the guard is what stops such an item
 * being promoted to `published` (the first arm tested) about posts nobody sent.
 * Anything transcribing this fold into SQL owes the same guard — written with
 * `exists` in migration 0018, where it reads as the same clause. SQL would in
 * fact fail closed without it (`bool_and` over an empty set is `NULL`, and a
 * `WHERE` that cannot decide updates nothing), which is the opposite of this
 * `every`: the danger is in THIS language, and the transcription keeps the
 * clause so the two can be read side by side.
 */
export function nextItemStatus(statuses: readonly AdaptationStatus[]): ContentStatus | undefined {
  if (statuses.length === 0) return undefined;
  if (statuses.every((status) => status === "published")) return "published";
  if (statuses.every((status) => status === "failed")) return "failed";
  // EVERY DELIVERY IS OVER AND THEY DISAGREED. Reached only after the two arms
  // above have claimed the unanimous cases, so "at least one published and at
  // least one not" is what is left rather than a clause this line has to
  // restate — and the `every` here is what keeps a fan-out with a `queued` or
  // `publishing` half out of it, which is the whole difference between "this
  // is how it ended" and "this is how far it has got".
  if (statuses.every((status) => status === "published" || status === "failed")) {
    return "partially_published";
  }
  return undefined;
}

/**
 * A DELIVERY THAT STILL HAS A PUBLISH JOB BEHIND IT — and therefore the exact
 * set of rows a canceller must cancel and a worker may still send.
 *
 * `scheduled` is a job waiting on its `startAfter`, `queued` is one waiting for
 * a worker, and `publishing` is one mid-attempt whose transient-retry chain is
 * still live. `pending` and `failed` have no job; `published` is history.
 *
 * FOUR CALL SITES SPELLED THIS OUT AS A LITERAL, in two apps and from two
 * directions — "what must I cancel?" (`BrandsRepository.delete`,
 * `ChannelsRepository.delete`, `ContentRepository.reject`) and "what may I
 * send?" (`PublishRepository`'s claim). They are one set because they are one
 * fact: a live pg-boss job exists for this row. Leaving `publishing` out of the
 * cancel half is a defect this product has already shipped once — the reject
 * matched nothing, the retry chain ended on its own, and the adaptation sat in
 * `publishing` for ever with no job behind it — so the two halves disagreeing
 * is not a hypothetical.
 *
 * Written as a member list rather than as "not pending, failed or published"
 * on purpose: the complement fails OPEN, and a status added later would land
 * inside the cancel set and inside the claim set without anyone deciding it
 * should. `adaptations_one_live_per_item_channel` is written the other way
 * round for the opposite reason — there, admitting a new status is the safe
 * direction.
 */
export const OUTSTANDING_ADAPTATION_STATUSES = [
  "queued",
  "scheduled",
  "publishing",
] as const satisfies readonly AdaptationStatus[];
export type OutstandingAdaptationStatus = (typeof OUTSTANDING_ADAPTATION_STATUSES)[number];

/** Does this adaptation still have a publish job behind it? */
export function isOutstandingAdaptation(status: AdaptationStatus): boolean {
  return (OUTSTANDING_ADAPTATION_STATUSES as readonly string[]).includes(status);
}

/**
 * What one delivery attempt is, or ended as — `publications.status`.
 *
 * `in_flight` is the only non-terminal one, and it is written BEFORE the
 * request goes to the platform rather than after it comes back — it is the
 * claim that says "an attempt is out there". `unknown` is what a claim becomes
 * when the attempt never came back to resolve it: the request left, the answer
 * did not, and nobody can say from here whether a post is live. Neither is a
 * failure and neither is a success; a human has to look at the channel.
 */
export const PUBLICATION_STATUSES = ["in_flight", "published", "failed", "unknown"] as const;
export type PublicationStatus = (typeof PUBLICATION_STATUSES)[number];

/**
 * WHY A DELIVERY ENDED — `adaptations.failure_reason`, the CLASS of a failure
 * as opposed to the sentence about it.
 *
 * `last_error` is free `text` printed verbatim on the content screens, and the
 * web has already been burned keying behaviour off a worker sentence's prefix
 * (`apps/web/src/lib/adaptations.ts`: a reworded log line turned every unknown
 * delivery back into a plain red Failed). A reader that has to ask WHICH kind
 * of failure this was — the screen captioning a missed slot, a future report,
 * an operator filtering — asks this column, and the sentence stays free text
 * for the platform's own words.
 *
 * CLOSED OVER TODAY'S TERMINAL WRITES, and `null` is not an "other" bucket.
 * Every write that lands an adaptation in `failed` names one of these, so the
 * column always answers for the row's CURRENT verdict; every write that moves
 * the row OFF a verdict (`markPublished`, `markPublishing`, `approve`,
 * `reject`, the delivery resolver) clears it in the same statement that clears
 * `lastError`. `null` survives for exactly one population: rows that failed
 * BEFORE the column existed, which the screens render from `last_error` as
 * they always did.
 *
 * Pinned in the database as well as in the types
 * (`adaptations_failure_reason_check`), like every other closed set here.
 */
export const PUBLISH_FAILURE_REASONS = [
  /** The slot came and went while nothing could deliver it — see `PUBLISH_MAX_LATENESS_HOURS`. */
  "schedule_missed",
  /** No publisher is registered for the channel's platform. */
  "no_adapter",
  /** The stored credential blob would not decrypt — a key is gone or the ciphertext is corrupt. */
  "credentials_unreadable",
  /**
   * The channel row the credentials live on has been deleted.
   *
   * DEFENSIVE, and no screen can show it: `adaptations.channel_id` is
   * `ON DELETE CASCADE` and channels are hard-deleted, so the delete that makes
   * a channel missing takes the adaptation with it and leaves nothing to
   * caption. It was a CATCH-ALL until 2026-09-12 — every other failure of the
   * credentials SELECT, a dropped connection included — which put a sentence
   * about a disconnected channel, and advice to re-add it, on rows whose
   * channel was fine. Those are transient now and retry; this member says only
   * what the worker actually saw.
   */
  "credentials_missing",
  /** The stored credentials do not satisfy the adapter's own schema. */
  "credentials_invalid",
  /** The platform's own envelope refused the post, permanently. */
  "platform_rejected",
  /**
   * REFUSED BEFORE THE PLATFORM EVER SAW IT — the adapter's own pre-flight
   * guards (a body over the platform's text limit, a payload that will not
   * serialize) and a 4xx that did not carry the platform's envelope, which is
   * something between us and it refusing to forward.
   *
   * Split off `platform_rejected` because the sentence quotes the message: with
   * one code for both, the screen read "The platform refused this post: Text
   * must be 1..4096 characters, got 5000" — our own words attributed to
   * somebody else, about a request that never left. Which class a permanent
   * refusal is comes from `PlatformRejectionError`, raised by adapters for the
   * envelope case only, and never from reading the message.
   */
  "rejected_before_send",
  /** pg-boss spent the queue's retries on transient failures and dead-lettered the job. */
  "retries_exhausted",
  /** An attempt stopped before it reached the platform and no job is left to retry it. */
  "send_abandoned",
  /**
   * The request left this process and the answer never came back: a post MAY be
   * live. The one reason on this list that is not a statement that nothing was
   * sent, and the reason `publications.status` has an `unknown` of its own.
   */
  "outcome_unknown",
] as const;
export type PublishFailureReason = (typeof PUBLISH_FAILURE_REASONS)[number];

/**
 * Who wrote the text — `content_items.origin`, `adaptations.origin` and
 * `content_versions.origin`.
 */
export const CONTENT_ORIGINS = ["ai", "human"] as const;
export type ContentOrigin = (typeof CONTENT_ORIGINS)[number];

/**
 * How much of a body a version row holds. `full` is a whole body — the only
 * kind that can be restored, listed as history, or answer the publish gate's
 * "did a human delete something" clause. `fragment` is a refine proposal's
 * replacement text, which is evidence of a touch but is not a body.
 */
export const VERSION_SCOPES = ["full", "fragment"] as const;
export type VersionScope = (typeof VERSION_SCOPES)[number];

/**
 * The refine verbs the editor may ask the model to apply to a selection.
 *
 * Closed, on purpose, and not an oversight: this increment ships no free-text
 * instruction field. `defineStep`'s own barrel comment (`@pubrick/ai`) says
 * why — `role` is caller-supplied text that lands verbatim in the system half,
 * and a user-typed instruction is untrusted text that belongs in `material`,
 * never there. Getting that boundary right for a real instruction field is a
 * later increment's work; three fixed verbs, each with role lines fixed at
 * this end (`apps/api/src/content/refine.step.ts`), sidestep the question
 * rather than answer it.
 *
 * One declaration, three consumers, for the reason every other closed set in
 * this file gives: `refine_proposals.verb`'s CHECK constraint, the refine
 * step's `Record<RefineVerb, …>` of role lines, and the editor's verb `Menu`
 * all read this array rather than restating it. A fourth verb is one member
 * here, one role-lines entry, and four translated menu labels — not three
 * lists that have to be kept in step by hand.
 */
export const REFINE_VERBS = ["shorten", "warmer", "punchier"] as const;
export type RefineVerb = (typeof REFINE_VERBS)[number];

/**
 * The same closed set, as a runtime refusal.
 *
 * `RefineVerb` is a compile-time guarantee and every verb this product will
 * ever hold arrives as a string off an HTTP body, where the compiler has no
 * say: a route that reads `body.verb` and hands it on has a `string` the type
 * says is one of three. Parsing it here is what turns the type back into a
 * check, and it belongs beside the array for the reason the array itself
 * exists — `refine_proposals.verb`'s CHECK, the step's role-lines `Record` and
 * the editor's `Menu` already read one declaration, and a second enum written
 * out by hand at the route would be a fourth list to keep in step.
 */
export const refineVerbSchema = z.enum(REFINE_VERBS);

/**
 * How many BILLED model calls one organisation's refine verbs may make in a
 * rolling hour.
 *
 * `MAX_TEST_CALLS_PER_HOUR`'s design, deliberately copied — including its
 * mechanism, which is a rolling count of the `usage_ledger` rows the calls
 * themselves wrote rather than a bucket in memory. What is NOT copied is the
 * budget: that count is filtered `step = 'test'` and this one `step =
 * 'refine'`, so neither allowance can be spent by the other button. A person
 * who has just exhausted Settings' Test allowance can still refine a sentence,
 * and a generation run's dozen calls do not lock the editor — which is the
 * point of counting a step rather than an org's whole bill.
 *
 * WHY THERE IS A NUMBER HERE AT ALL. `POST /api/content/:id/refine` is the
 * first route in this product that a person can make spend money REPEATEDLY,
 * BY HAND, on content: press, read, Try again, press. It is guarded by
 * membership and nothing else — the api still has no throttler of any kind —
 * and it inherits nothing from the Test button, whose allowance names a step
 * this call does not write.
 *
 * WHY 120, AND WHY COUNTED IN CALLS. The unit is the thing being protected. A
 * refine sends at most a whole body plus its selection and gets a selection
 * back, which is roughly $0.001–$0.0025 a CALL, and so $0.002–$0.005 a press at
 * the two round trips `maxRetries: 0` allows (the call, and
 * `generateStructured`'s repair retry for a schema violation). The ledger
 * writes one row per PHYSICAL call, so a press that met the repair retry
 * consumes two and the limit bounds money rather than clicks.
 *
 * The ceiling is therefore about $0.30 an hour — 120 CALLS at the upper
 * estimate, not 120 presses at it, which is the arithmetic this docstring used
 * to get wrong in the safe direction. Both figures are `gemini-3.7-flash`'s
 * ($0.75/$3.75 per Mtok, `packages/ai/src/pricing.ts`), the model the number was
 * picked against; the model is the ORG's choice, and the priciest one the price
 * table knows — `gemini-3.1-pro-preview`, $2/$12 — is about three times that, so
 * roughly $1 an hour. Both stay two orders of magnitude below the unbounded hole
 * a loop over this endpoint would otherwise be, and the cheap-model figure is
 * the same order as the Test button's own $0.24.
 *
 * The other half of the judgement, and the half that picks the number: honest
 * use is a person editing one draft, and the dossier's staging loop makes them
 * READ each proposal and decide — Accept, Try again, Discard. 120 calls is
 * between 60 and 120 presses, a press every thirty seconds for a solid hour,
 * which no read-and-judge loop approaches. Far above honest use, far below
 * abuse, and the gap between them is wide enough that there is nothing to
 * shave.
 *
 * NOT A DOLLAR CAP. `spend()` stays display-only and this bounds calls, which
 * is the same honest approximation the Test button makes: the exact price of a
 * call is the provider's to decide and is not known until after it is made.
 */
export const MAX_REFINE_CALLS_PER_HOUR = 120;

export const MAX_BODY_LENGTH = 4096;

/**
 * A post body, in the one canonical form the rest of the product may assume:
 * newlines are U+000A and nothing else.
 *
 * The normalisation is not tidying. A `<textarea>` strips CR from its API
 * value, so a body carrying one makes the provenance lens's overlay — which
 * renders slices of the string, not of the DOM value — lay down a different
 * number of characters than the field it sits on, sliding every highlight
 * after it off the words it describes and making the counter report a length
 * the field does not hold. `normalizeNewlines`' own docstring has the full
 * mechanism.
 *
 * It belongs **here**, at the DTO, because this is the boundary every writer
 * crosses: the web app, the public API, the MCP server, a script. Fixing it in
 * the component would leave the gate and the mask comparing a stored CR body
 * against a stored CR-free version row.
 *
 * Normalise first, bound second: `MAX_BODY_LENGTH` is the length of what gets
 * *stored*, and CRLF input that fits once collapsed must not be refused for a
 * character the product is about to drop anyway.
 */
const bodyText = z
  .string()
  .refine((text) => !hasNulByte(text), { message: NO_NUL_BYTE_MESSAGE })
  .transform(normalizeNewlines)
  .pipe(z.string().min(1).max(MAX_BODY_LENGTH));

/**
 * A title is stored in the same kind of column as a body and refuses the same
 * character, for the same reason (`hasNulByte`). It is NOT piped through
 * `normalizeNewlines`: a title is a single line, and normalising it would make
 * `max(300)` measure a different string than it measures today with no defect
 * behind the change — `runCreateSchema.brief`'s own argument.
 */
const titleText = z
  .string()
  .max(300)
  .refine((text) => !hasNulByte(text), { message: NO_NUL_BYTE_MESSAGE });

export const contentCreateSchema = z.object({
  brandId: z.string().uuid(),
  title: titleText.optional(),
  body: bodyText,
  channelIds: z
    .array(z.string().uuid())
    .min(1)
    .max(20)
    // Duplicates are rejected, exactly as `runCreateSchema` rejects them, and
    // for a sharper reason than the run's: here a repeated id is a repeated
    // POST. `create()` writes one `adaptations` row per resolved channel, and
    // an adaptation IS a delivery — `approve` enqueues one publish job per row
    // — so an item admitted with the same channel twice would carry two rows
    // for one channel and send the post there twice, from a single approval.
    // The `publications` in-flight and published indexes cannot see it: both
    // are scoped to ONE adaptation, and these are two.
    //
    // This was NOT caught before, whatever the sibling schema's comment says.
    // What `create()` has is a COUNT comparison — it resolves the requested
    // ids against the brand's channels and compares `channels.length` with
    // `data.channelIds.length` — which a repeated id fails for the same
    // arithmetic reason a stranger's id does, and which therefore answers
    // "One or more channels do not belong to this brand": a 404 about tenancy
    // for a request whose channels are all present, all this brand's, and all
    // permitted. The caller is told to fix the one thing that is not wrong.
    // The refusal belongs here, where the fault is nameable, and the count
    // comparison goes back to meaning only what it can actually tell apart.
    //
    // It is not the guarantee either — `adaptations_one_live_per_item_channel`
    // is. This is the boundary that gives a human the right sentence.
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "channelIds must not contain duplicates",
    }),
});
export type ContentCreate = z.infer<typeof contentCreateSchema>;

/**
 * Every field is optional (it is a PATCH), so `{}` parses — but an empty SET
 * clause makes drizzle throw "No values to set", which surfaces as a 500 on
 * what is really a malformed request. Require at least one field.
 */
export const contentUpdateSchema = z
  .object({
    title: titleText.optional(),
    body: bodyText.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "Provide at least one field to update",
  });
export type ContentUpdate = z.infer<typeof contentUpdateSchema>;

export const adaptationUpdateSchema = z.object({
  /** `null` clears the override; this channel then ships the item's own body. */
  body: bodyText.nullable(),
});
export type AdaptationUpdate = z.infer<typeof adaptationUpdateSchema>;

/**
 * What the editor asks for when it asks the model to revise a selection: a
 * verb, and where the selection is.
 *
 * NO TEXT CROSSES THE WIRE, and that is the decision this schema records. The
 * caller names OFFSETS into the body the server already stores, and the server
 * slices its own copy; the selection it actually sent to the model comes back
 * on the 201 as `selectedText`, so a caller whose idea of the body had moved
 * can see that it had rather than be quietly refined somewhere else.
 *
 * Sending the selected text instead — or as well — would be the same mistake
 * the staged proposal exists to prevent, arriving one step earlier. A caller
 * that supplies the text supplies what the model is asked about, and the row
 * this call stages is the product's evidence about what a MODEL wrote; the
 * shorter the distance between the stored body and the model's input, the less
 * of that evidence a caller authors. It also removes a whole class of
 * disagreement: with one string in play there is no second one to be stale.
 *
 * `end` is exclusive and `start < end`, so a collapsed caret cannot be
 * refined — there would be nothing to replace, and the model's schema requires
 * a non-empty replacement for it. `MAX_BODY_LENGTH` bounds both because a body
 * cannot be longer; the range must also lie inside the CURRENT body, which
 * only the repository can check and which it refuses as `invalid_request`.
 *
 * The offsets index the body in the one canonical form the DTO stores
 * (`normalizeNewlines`, U+000A and nothing else) — which is why
 * `DimmedTextarea`'s selection callback reports the exact string its offsets
 * index rather than the `value` it was handed. UTF-16 code units, as every
 * JavaScript string offset is; nothing in the database re-measures them
 * (Postgres `length()` counts code POINTS, and the two disagree on every emoji
 * in ordinary social copy).
 */
export const refineRequestSchema = z
  .object({
    verb: refineVerbSchema,
    start: z.number().int().min(0).max(MAX_BODY_LENGTH),
    end: z.number().int().min(1).max(MAX_BODY_LENGTH),
  })
  .refine((data) => data.start < data.end, {
    message: "end must be greater than start",
  });
export type RefineRequest = z.infer<typeof refineRequestSchema>;

/**
 * The proposal a refine staged — `POST /api/content/:id/refine`'s 201, and the
 * row Accept later reads back.
 *
 * Every field is the SERVER's: `proposal` and `reason` are the model's own
 * words as this request received them, and `selectedText` is the slice of the
 * stored body they were written against. The screen renders them beside the
 * draft and hands `id` back to Accept, which reads the row rather than
 * anything the browser echoes — a caller that could supply the text could make
 * the product caption its own words "AI-drafted".
 *
 * `reason` comes back in the BRAND's content language, not the reader's UI
 * locale: `instructionsFor` (`@pubrick/ai`) tells the model to write every word
 * of its output in that language, unconditionally. Showing it beside a
 * locale-translated verb label is the honest arrangement; translating it is a
 * later increment's problem.
 *
 * IT REACHES A SCREEN TWICE, and the second way is what makes a refine survive
 * a reload: as this route's 201, and as `refineProposal` on
 * `GET /api/content/:id`, which is `null` when the draft has nothing staged. A
 * press is paid for the moment its row is written, so without the second the
 * only copy of a proposal anyone ever saw was in one browser tab — a reload, a
 * crash or a second device stranded a row nothing could reach.
 *
 * On the ITEM's own response rather than behind a `GET /:id/refine`, for
 * `runId`'s reason: the item screen already reads and polls that endpoint, so
 * this costs no round trip, while a second endpoint would be either polled
 * beside it or left to go stale — stale against exactly the body the proposal's
 * anchor is re-located in. It is deliberately NOT on the LIST rows: a queue
 * card never draws a suggestion, and a list that carried them would ship every
 * staged proposal in the organisation to render cards that do not mention them.
 *
 * The two routes that consume it take its OWN id, never merely the draft's:
 * `POST /api/content/:id/refine/:proposalId/accept` (200, the item) and
 * `DELETE /api/content/:id/refine/:proposalId` (204). A press that superseded
 * this proposal staged a different one, and an Accept aimed at the card
 * somebody was reading must not apply the one that replaced it — so a stale id
 * is `refine_proposal_not_found`, which is the honest answer.
 */
export type RefineProposal = {
  id: string;
  verb: RefineVerb;
  proposal: string;
  reason: string;
  start: number;
  end: number;
  selectedText: string;
};

export const contentApproveSchema = z.object({
  /**
   * ISO timestamp; when omitted the post is queued immediately.
   *
   * IT MUST ALSO BE IN THE FUTURE — pg-boss treats a past `startAfter` as "run
   * now", so a typo'd or stale date would silently publish immediately instead
   * of being scheduled — but that rule is NOT here any more. It is
   * `ContentRepository.approve`'s, and it moved for two reasons that point the
   * same way.
   *
   * It is not a shape rule. This schema says what a well-formed request looks
   * like, and a shape does not stop being well-formed while you look at it; a
   * clock-reading `.refine` returns a different verdict for the same bytes a
   * moment later, which is a domain rule wearing a schema's clothes.
   *
   * And where it stood it could not be named. The pipe refuses a whole body
   * with one code (`invalid_request`), so the user was shown the developer's
   * string — "scheduledAt: scheduledAt must be in the future", the pipe's
   * `path: message` join wrapped around a message naming the field again. As a
   * domain refusal it has its own code, `schedule_in_past`, and says "pick a
   * time in the future" in four languages.
   *
   * `.datetime()` stays: THAT is a shape.
   */
  scheduledAt: z.string().datetime().optional(),
});
export type ContentApprove = z.infer<typeof contentApproveSchema>;

/**
 * WHAT A PERSON SAW WHEN THEY OPENED THE CHANNEL — the body of
 * `POST /api/content/:id/adaptations/:adaptationId/delivery`.
 *
 * One boolean, because the question is one question: an attempt whose answer
 * never came back is either live in the channel or it is not, and only a human
 * who looked can say which. `true` records a delivery nobody can produce a
 * platform id for; `false` records that nothing arrived, which puts the
 * delivery back in reach of "Publish now".
 *
 * NO FREE TEXT, no external id, no link. A caller that could supply an id
 * could author the product's evidence that a platform accepted a post, which
 * is the same boundary `refineRequestSchema` draws when it sends offsets
 * instead of the selected text. What the receipt carries instead is WHO said
 * so (`publications.asserted_by`, from the session) and when, which is what
 * the item screen renders in place of a link it does not have.
 */
export const deliveryAssertionSchema = z.object({
  delivered: z.boolean(),
});
export type DeliveryAssertion = z.infer<typeof deliveryAssertionSchema>;

/**
 * WHAT HAPPENED TO ONE CHANNEL'S POST — the `deliveryOutcome` the api reports
 * on every adaptation it returns, and the only field a screen needs in order to
 * label a delivery.
 *
 * Six of the seven values are the adaptation row's own `status`, forwarded:
 *
 * - `pending` — created, not approved yet. Nothing has been sent.
 * - `scheduled` — approved for a future time; the queue holds the job until it.
 * - `queued` — approved and handed to the queue; a worker will pick it up.
 * - `publishing` — a worker is talking to the platform right now.
 * - `published` — the platform accepted the post. This is the one outcome that
 *   carries an `externalUrl`.
 * - `failed` — the attempt ended and NOTHING reached the platform. Safe to
 *   approve again: re-approving sends the post for the first time.
 *
 * The seventh has no column of its own and is the reason this field exists:
 *
 * - `unknown` — the request may have left this process and never came back.
 *   The post may be live in the channel and nothing here can tell. It carries
 *   no `externalUrl` — there is no answer to have learned one from — and it is
 *   emphatically NOT `failed`: re-approving an unknown delivery can put a
 *   SECOND copy in someone's channel, so a human has to open the channel and
 *   look first.
 *
 * The adaptation column cannot hold that seventh value: `failed` is its only
 * terminal-and-not-published state, and the distinction lives one table over,
 * on the `publications` receipt the worker writes per attempt (`unknown`
 * there). The api joins the two — a `failed` adaptation whose most recent
 * finished receipt says `unknown` is reported here as `unknown` — so that a
 * browser never has to, and so the queue and the item screen cannot disagree.
 * The status is part of the pair on purpose: a re-approved adaptation is
 * `queued` again, and an older attempt's `unknown` receipt must not keep
 * describing the delivery that is currently in flight.
 *
 * DERIVED FROM `ADAPTATION_STATUSES` rather than spelled out beside it. "Six
 * of the seven values are the adaptation row's own status" IS the definition,
 * so a seventh adaptation status has to appear here — and the moment it does,
 * every `Record<DeliveryOutcome, …>` in the web is missing a key and stops
 * compiling, which is exactly where the decision about its color belongs.
 * Written out by hand it would just be a shorter list than the column, and the
 * badge lookup would answer `undefined` for the new status and paint a badge
 * with `undefined` classes.
 */
export const DELIVERY_OUTCOMES = [...ADAPTATION_STATUSES, "unknown"] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

/** Is this string one of the outcomes? Guards a value read back off the wire. */
export function isDeliveryOutcome(value: unknown): value is DeliveryOutcome {
  return typeof value === "string" && (DELIVERY_OUTCOMES as readonly string[]).includes(value);
}
