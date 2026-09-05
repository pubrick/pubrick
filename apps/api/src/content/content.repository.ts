import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import type { AiCredential, StepBrand } from "@pubrick/ai";
import { schema } from "@pubrick/db";
import {
  type AdaptationStatus,
  type AdaptationUpdate,
  type AiVersionRow,
  type ApiErrorCode,
  allSentencesAi,
  CONTENT_STATUSES,
  type ContentCreate,
  type ContentStatus,
  type ContentUpdate,
  type DeliveryOutcome,
  isMalformedStoredAiCredential,
  isSameText,
  isUnreadableCiphertext,
  MAX_BODY_LENGTH,
  MAX_REFINE_CALLS_PER_HOUR,
  normalizeForComparison,
  normalizeNewlines,
  OUTSTANDING_ADAPTATION_STATUSES,
  planRefineAccept,
  type RefineAcceptPlan,
  type RefineProposal,
  type RefineRequest,
  type RefineVerb,
  toLedgerCostUsd,
} from "@pubrick/shared";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { AiCredentialsRepository } from "../ai-credentials/ai-credentials.repository";
import { badRequest, conflict, notFound } from "../api-error";
import { db } from "../db";
import { QueueService } from "../queue/queue.service";
import { RefineCaller, type RefineFailure, type RefineUsage } from "./refine.caller";
import { REFINE_STEP } from "./refine.step";

const ITEM_COLUMNS = {
  id: schema.contentItems.id,
  brandId: schema.contentItems.brandId,
  title: schema.contentItems.title,
  body: schema.contentItems.body,
  status: schema.contentItems.status,
  /**
   * Who wrote this text. Exposed because the origin badge is DERIVED, not
   * stored (generation-engine spec §6): `human` reads human-written, `ai` reads AI-drafted or
   * human-edited depending on `bodyIsAiVerbatim` — whether every sentence of
   * the body is still one the model wrote.
   */
  origin: schema.contentItems.origin,
  createdAt: schema.contentItems.createdAt,
  updatedAt: schema.contentItems.updatedAt,
};

/**
 * Item statuses in which the text is still the author's to change.
 *
 * Approval PINS the content. The worker reads `content_items.body` (or the
 * adaptation's override) at EXECUTION time, not at approval time, so an edit
 * accepted after an approval does not touch a copy — it replaces the reviewed
 * text of a post that is already queued or scheduled with text nobody reviewed.
 * Editing is therefore refused outright once the item leaves this set, rather
 * than silently resetting it to `draft`: taking an approval back is a decision,
 * and the reviewer makes it explicitly (reject, edit, approve again).
 *
 * `failed` IS in the set, and deliberately so. Nothing is pinned by it:
 * `recomputeItemStatus` only writes `failed` once EVERY adaptation has failed,
 * so no delivery is outstanding, no post is live, and no approval is being
 * revoked — and a late dead-letter delivery cannot resurrect one either, since
 * `markExhausted` acts only on an adaptation still in `publishing`. Excluding
 * it was also incoherent with `approve`, which re-targets `failed` adaptations:
 * the same failed text could be re-sent in one click but not CORRECTED without
 * a reject first, even though the most common permanent failure IS the content
 * (Telegram 400: too long, bad entities). Fixing the text is the entire point
 * of that screen.
 *
 * `as const satisfies` rather than a `readonly ContentStatus[]`
 * annotation: both make a typo a compile error, but this one also keeps the
 * literal member types, which is what lets `PINNED_ITEM_MESSAGE` below be
 * exhaustive by construction.
 */
const EDITABLE_ITEM_STATUSES = [
  "draft",
  "rejected",
  "failed",
] as const satisfies readonly ContentStatus[];

type EditableItemStatus = (typeof EDITABLE_ITEM_STATUSES)[number];
/** The complement: every status in which the text is pinned. */
type PinnedItemStatus = Exclude<ContentStatus, EditableItemStatus>;

/**
 * The 409 body, in the words of the status the user is actually looking at.
 *
 * A single sentence could not tell the truth here: "Approved content cannot be
 * edited" is a lie about an item the UI labels "Published", and was one about
 * "Failed" until that became editable. Keying the message off the status keeps
 * the two in step, and typing the record over `PinnedItemStatus` means adding a
 * status to `CONTENT_STATUSES` without deciding what it means for editing is a
 * compile error here rather than a confident wrong sentence in the UI.
 */
const PINNED_ITEM_MESSAGE: Record<PinnedItemStatus, string> = {
  approved: "Approved content cannot be edited; reject it first",
  published: "This content has already been published and can no longer be edited",
};

/**
 * The same refusal, as the code the web turns into a translated sentence.
 *
 * A SECOND record over the same key rather than one record of pairs, because
 * the sentence above is a different artefact with a different audience: it is
 * the developer's, it is quoted verbatim by tests that predate codes, and it
 * says "content" where the screens say "post". The code is what the reader
 * gets, in four languages, and it carries the status in its NAME — which is
 * exactly why "Approved content cannot be edited" being a lie about a
 * published item forced this record to be keyed by status in the first place.
 * Both are total over `PinnedItemStatus`, so a new status is still a compile
 * error in both places.
 */
const PINNED_ITEM_CODE: Record<PinnedItemStatus, ApiErrorCode> = {
  approved: "content_pinned_approved",
  published: "content_pinned_published",
};

/**
 * Adaptation statuses with no delivery in flight, so an override is still safe
 * to change. Same shape, same reasoning as the item set above.
 */
const EDITABLE_ADAPTATION_STATUSES = [
  "pending",
  "failed",
] as const satisfies readonly AdaptationStatus[];

type EditableAdaptationStatus = (typeof EDITABLE_ADAPTATION_STATUSES)[number];
type PinnedAdaptationStatus = Exclude<AdaptationStatus, EditableAdaptationStatus>;

/** Per-status 409 body for one channel's override — exhaustive, as above. */
const PINNED_ADAPTATION_MESSAGE: Record<PinnedAdaptationStatus, string> = {
  scheduled: "A scheduled post cannot be edited; reject the content first",
  queued: "A post already queued for publishing cannot be edited; reject the content first",
  publishing: "A post that is being published right now cannot be edited; reject the content first",
  published: "This channel's post has already been published and can no longer be edited",
};

/** The same four refusals as codes — see `PINNED_ITEM_CODE`. */
const PINNED_ADAPTATION_CODE: Record<PinnedAdaptationStatus, ApiErrorCode> = {
  scheduled: "adaptation_pinned_scheduled",
  queued: "adaptation_pinned_queued",
  publishing: "adaptation_pinned_publishing",
  published: "adaptation_pinned_published",
};

/** Postgres foreign_key_violation. */
const FOREIGN_KEY_VIOLATION = "23503";

/**
 * Did this write fail because a row it referenced is gone?
 *
 * Checks the error AND its `cause`: drizzle wraps the driver's error, but the
 * `code` belongs to node-postgres's `DatabaseError` underneath. A second copy
 * of the worker's own predicate, and deliberately a copy — the two processes
 * share no code and this one is four lines.
 *
 * It has one reachable cause on this route, and it is not exotic: a refine is a
 * request that spends forty-five seconds outside any transaction, and
 * `DELETE /api/brands/:id` cascades into `content_items`. A draft deleted while
 * the model was answering is a real interleaving, not a hypothetical.
 */
function isForeignKeyViolation(error: unknown): boolean {
  type PgLike = { code?: unknown; cause?: unknown };
  return [error, (error as PgLike | undefined)?.cause].some(
    (candidate) => (candidate as PgLike | undefined)?.code === FOREIGN_KEY_VIOLATION,
  );
}

/**
 * The refusal a pinned item earns, or `null` while its text is still the
 * author's to change.
 *
 * ONE reading of "editable", shared by the two paths that ask: `update`, which
 * asks under `SELECT … FOR UPDATE`, and `refine`, which deliberately asks
 * without a lock. The predicate and the two records it indexes are the same
 * either way — a refine admitted against text an approval has pinned is a
 * refine whose Accept could only ever be refused, so the two must not be able
 * to answer differently.
 *
 * Returns the exception rather than throwing it, so a caller that has a lock
 * open can see the refusal as a value.
 */
function pinnedItemRefusal(status: ContentStatus) {
  if (isEditableItemStatus(status)) return null;
  return conflict(PINNED_ITEM_CODE[status], PINNED_ITEM_MESSAGE[status]);
}

/**
 * The window `MAX_REFINE_CALLS_PER_HOUR` is counted over.
 *
 * A literal interval rather than a computed `Date`, for the reason
 * `TEST_BUDGET_WINDOW` (`ai-credentials.repository.ts`) documents at length:
 * the comparison happens in Postgres against `usage_ledger.created_at`, which
 * is `timestamp` WITHOUT time zone and is written by the database's own
 * `now()`. A JavaScript `Date` from an api replica in another zone shifts the
 * window by the offset, which either waves every request through or refuses
 * every one of them.
 */
const REFINE_BUDGET_WINDOW = sql`interval '1 hour'`;

/**
 * The two model failures a refine reports, as codes and as sentences — two
 * records over one union, exactly as the pinned-status pair above, and total
 * over `RefineFailure` so a third failure shape cannot be added without
 * deciding what the reader is told about it.
 *
 * The provider's own words never appear in either: they quote the submitted
 * API key back (see `AI_TEST_FAILURES`), and this value is handed to a browser.
 */
const REFINE_FAILURE_CODE: Record<RefineFailure, ApiErrorCode> = {
  timed_out: "refine_timed_out",
  failed: "refine_failed",
};

const REFINE_FAILURE_MESSAGE: Record<RefineFailure, string> = {
  timed_out: "The model did not answer in time; nothing was changed",
  failed: "The model could not revise this selection; nothing was changed",
};

/**
 * The columns a staged proposal is ever read or returned through — one
 * allowlist, shared by the INSERT that stages one and the read that hands it
 * back on the item.
 *
 * Shared rather than spelled twice because the two are the same object to
 * everything downstream: the 201 of a press and the `refineProposal` a reload
 * finds are the same card, and two column lists would be two shapes a screen
 * could tell apart. `org_id`, `content_item_id` and `created_by` are
 * deliberately absent — a caller who is being handed this row already knows
 * which draft of theirs it belongs to, and who asked is the ledger's and the
 * row's business, not the browser's.
 */
const PROPOSAL_COLUMNS = {
  id: schema.refineProposals.id,
  verb: schema.refineProposals.verb,
  proposal: schema.refineProposals.proposal,
  reason: schema.refineProposals.reason,
  start: schema.refineProposals.startOffset,
  end: schema.refineProposals.endOffset,
  selectedText: schema.refineProposals.selectedText,
};

/**
 * The two refusals `planRefineAccept` can answer with, as codes and sentences —
 * a record total over its refusal reasons, exactly as `REFINE_FAILURE_CODE` is
 * over the model's, so a third reason cannot be added there without deciding
 * what the reader is told about it here.
 *
 * Both leave the staged proposal in place. The person paid for it, and each of
 * these is recoverable by an act of theirs: re-select the whole sentence, or
 * shorten the post.
 */
const REFINE_PLAN_REFUSAL: Record<
  Extract<RefineAcceptPlan, { ok: false }>["reason"],
  { code: ApiErrorCode; message: string }
> = {
  would_launder: {
    code: "refine_would_launder",
    message:
      "Accepting this would record words a person wrote as the model's; " +
      "select the whole sentence rather than part of it, and ask again",
  },
  too_long: {
    code: "refine_too_long",
    message: `Applying this suggestion would make the post longer than ${MAX_BODY_LENGTH} characters`,
  },
};

/**
 * WHERE THE SELECTION IS NOW — the occurrence of `selectedText` nearest the
 * offset the proposal stored, or `null` when the draft no longer contains it
 * anywhere.
 *
 * RE-LOCATED, NEVER TRUSTED. The stored offsets were measured against the body
 * as it stood when the model was asked, and a person editing while they read
 * the proposal is the commonest interaction there is; splicing at a stale
 * offset would replace whatever happens to sit there now.
 *
 * NEAREST, and not the first match. A repeated hook line is ordinary social
 * copy, and `indexOf` would rewrite a copy of the sentence three paragraphs
 * from the one they selected — silently, since both splices succeed and only
 * one of them is what they asked for.
 *
 * REFUSED ONLY WHEN THERE IS NONE, and not on "the body changed". Hashing the
 * whole body would throw away a paid-for call for an edit somewhere else
 * entirely, which is the opposite of what the proposal surviving its refusals
 * is for. "Ambiguous" is not a refusal either, for the same reason.
 *
 * Steps by ONE character rather than by the match's length, so overlapping
 * occurrences are all considered; on a tie the earlier one wins, because a
 * total order that is arbitrary is still better than one that depends on scan
 * direction.
 *
 * Measured survivor (`docs/mutation-testing.md`): stepping by the match's
 * length instead SURVIVES 3/3. A selection that overlaps its own next
 * occurrence ("abab" in "ababab") is the only input the two steps tell apart,
 * and no test builds one; the tie rule beside it is pinned. Recorded rather
 * than pinned because the case is contrived and the line is argued for above.
 */
function nearestOccurrence(body: string, selectedText: string, storedStart: number): number | null {
  let best: number | null = null;
  for (let at = body.indexOf(selectedText); at !== -1; at = body.indexOf(selectedText, at + 1)) {
    if (best === null || Math.abs(at - storedStart) < Math.abs(best - storedStart)) best = at;
  }
  return best;
}

/**
 * The text a refine request selected, sliced out of the body the SERVER holds.
 *
 * The request names offsets and no text at all (`refineRequestSchema`), so this
 * is the only place a selection comes from — which is what keeps the staged
 * proposal's anchor a fact about the stored draft rather than a claim a caller
 * made about it.
 *
 * TWO REFUSALS, both `invalid_request`, and the code is a judgement rather than
 * a shrug. `API_ERROR_CODES` keeps one code for the whole validation boundary
 * because the alternative is a translated sentence per field per rule; these
 * two are that boundary's own kind of fault — a request describing a string the
 * server does not have — and the schema cannot make them because it cannot see
 * the body. The reader's sentence ("check what you entered") is true of both,
 * and neither is reachable from the shipped editor, which reports its selection
 * against the exact string it renders.
 *
 *  - A range past the end of the body. The caller is indexing text this server
 *    does not hold: a draft that moved, or offsets taken against a string that
 *    was never normalised.
 *  - A blank selection. Whitespace has nothing to revise, the model's own
 *    schema requires a non-empty replacement for it, and the blankness test is
 *    this product's own class (`normalizeForComparison`, U+200B included) and
 *    not `String.trim`'s.
 */
function selectionOf(body: string, request: RefineRequest): string {
  if (request.end > body.length) {
    throw badRequest(
      "invalid_request",
      `The selection (${request.start}-${request.end}) is outside this content's ${body.length}-character body`,
    );
  }
  const selection = body.slice(request.start, request.end);
  if (normalizeForComparison(selection) === "") {
    throw badRequest("invalid_request", "The selection is blank; select some text to refine");
  }
  return selection;
}

/**
 * The 409 for the product's headline promise: nothing publishes that no human
 * opened or touched.
 *
 * Written for the operator, not the log: it names the things that clear the
 * refusal, because each is one act away and none is discoverable from
 * "409 Conflict". The web app effectively never sees this — its item page fires
 * `POST /:id/opened` on render — which is exactly why it must read well for the
 * callers that will: the public API, the MCP server, and a script.
 *
 * TWO sentences, because one could not be true of both shapes the widened gate
 * refuses (`requireHumanInvolvement`, clause 1) — the same reason
 * `PINNED_ITEM_MESSAGE` above is keyed by status. Editing clears the refusal
 * only where the body has a COMPLETE `ai` version to be judged against: with
 * none, `allSentencesAi` takes its missing-evidence branch and answers "still
 * the model's" for every possible body, so a caller told to edit could rewrite
 * every word and be refused again, forever. That is not a corner: it is the
 * ordinary shape of a hand-typed draft whose CHANNEL text a refine verb wrote,
 * and it is exactly the case that the widening makes reachable.
 *
 * The second sentence promises only what always works — opening it. Editing one
 * channel's override does clear this shape too, but only when that channel has
 * a complete `ai` version of its own, so the message does not offer it.
 */
const UNREAD_AI_DRAFT_MESSAGE =
  "No one has read this AI-written draft yet; open it, or edit it, before approving";

/** The same refusal where editing cannot lift it — see above. */
const UNREAD_AI_DRAFT_OPEN_ONLY_MESSAGE =
  "No one has read the AI-written text in this content yet; open it before approving — " +
  "editing the body cannot clear this refusal, because no complete AI version of the body " +
  "was ever recorded";

/**
 * Deliveries a new schedule cannot be applied to — the exact complement, within
 * the statuses `approve` can meet, of the set it re-targets.
 *
 * `approve` locks and re-enqueues `pending | failed | scheduled`. `published`
 * is history and is refused one level up (`requireNotPublished`). What is left
 * is these two, and they are the rows the old code silently skipped while
 * answering 200 — see `requireScheduleReachesEveryChannel`.
 *
 * Written as the two members rather than as "everything the target list does
 * not contain", for the reason `OUTSTANDING_ADAPTATION_STATUSES` gives about
 * itself: the complement fails OPEN. A seventh adaptation status would land
 * inside a negated set without anybody deciding it should, and here that means
 * a new status silently going back to being skipped-and-reported-as-done.
 */
const UNSCHEDULABLE_STATUSES = [
  "queued",
  "publishing",
] as const satisfies readonly AdaptationStatus[];

function isEditableItemStatus(status: ContentStatus): status is EditableItemStatus {
  return EDITABLE_ITEM_STATUSES.some((editable) => editable === status);
}

function isEditableAdaptationStatus(status: AdaptationStatus): status is EditableAdaptationStatus {
  return EDITABLE_ADAPTATION_STATUSES.some((editable) => editable === status);
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const ADAPTATION_COLUMNS = {
  id: schema.adaptations.id,
  contentItemId: schema.adaptations.contentItemId,
  channelId: schema.adaptations.channelId,
  body: schema.adaptations.body,
  status: schema.adaptations.status,
  /**
   * Tracked per channel because the adaptation body is what actually reaches
   * the platform: an item a human wrote can still carry AI-adapted channel
   * bodies, which is the "AI-adapted" badge in the generation-engine spec's §6.
   */
  origin: schema.adaptations.origin,
  scheduledAt: schema.adaptations.scheduledAt,
  attemptCount: schema.adaptations.attemptCount,
  lastError: schema.adaptations.lastError,
  /**
   * The worker logs one `publications` row per delivery attempt
   * (apps/worker/src/publish/publish.repository.ts markPublished/markFailed)
   * but never writes back to the adaptation row itself, so the link the web
   * UI needs to render "published -> link" has to be pulled in here. A
   * correlated subquery on the most recent `published` publication for this
   * adaptation (verified to work inside both SELECT and RETURNING via a
   * standalone psql check). Plain SQL text rather than embedded table/column
   * objects in the template, since drizzle's `sql` tag interpolation of a
   * bare Table for a subquery FROM isn't exercised anywhere else in this
   * codebase — the literal column/table names here are the actual db names
   * from packages/db/src/schema/content-items.ts, not TS property names.
   *
   * Scoped to `published` and deliberately NOT widened to the `unknown`
   * receipts `deliveryOutcome` below reads: an unknown delivery has no link and
   * cannot have one — the worker writes `external_url = null` on every one of
   * them, because the answer that would have carried the id never arrived. That
   * absence IS the outcome, and the screens say where the post may have gone by
   * naming the CHANNEL, which they know without asking this subquery.
   *
   * The `order by`/`limit 1` are shape, not choice, and a mutation of either is
   * an equivalent one: `publications_one_published_per_adaptation` is a unique
   * partial index, so this filtered set holds at most ONE row and there is
   * nothing for an ordering to pick between. The scope is the same story from
   * the other side — every non-published receipt carries `external_url = null`,
   * and a `published` adaptation is terminal (`approve` does not target it), so
   * no receipt can ever be newer than the published one. The load-bearing part
   * is the correlation on `adaptation_id`, which is a tenancy question and is
   * tested as one.
   */
  externalUrl: sql<string | null>`(
    select external_url from publications
    where adaptation_id = adaptations.id and status = 'published'
    order by created_at desc
    limit 1
  )`,
  /**
   * WHAT HAPPENED TO THIS CHANNEL'S POST — `DeliveryOutcome`, the field the web
   * labels a delivery from. Its seven values are documented on the union in
   * `@pubrick/shared`; this is where the seventh is computed.
   *
   * The adaptation column has six: `failed` is its only
   * terminal-and-not-published state, so a send whose answer never came back —
   * the post may be live in the channel, nothing here can tell — is stored as
   * `failed` too. The distinction lives on the `publications` receipt the
   * worker writes per attempt, whose status is `unknown` for exactly that
   * ending (`PublishService.recordUnknownOutcome`, and `sweepAbandoned` for an
   * attempt that died holding its in-flight claim). Rounding it back to
   * `failed` invites the re-approval that posts a SECOND copy, which is the
   * whole reason the distinction exists.
   *
   * Computed HERE, in SQL, rather than in either browser screen:
   *
   * - It is one expression in `ADAPTATION_COLUMNS`, so every reader gets it —
   *   the list, the item, and `updateAdaptation`'s RETURNING — and a future
   *   one cannot forget to apply it. (The correlated subquery works in both
   *   SELECT and RETURNING; `externalUrl` above relies on the same.)
   * - The queue and the item screen ask the same question, and a verdict the
   *   server computes is a verdict they cannot answer differently — the reason
   *   `bodyIsAiVerbatim` is a server-computed boolean a few fields up.
   * - Before it, the only trace of an unknown outcome that reached a browser
   *   was the ENGLISH SENTENCE the worker happens to prefix `last_error` with,
   *   which the web recognised by `startsWith`. A reworded log line turned
   *   every unknown delivery back into a plain red failure, silently.
   *
   * BOTH HALVES OF THE CONDITION ARE LOAD-BEARING. `status = 'failed'` is what
   * scopes the receipt to the delivery being described: an unknown attempt
   * leaves its receipt behind for ever, and a human who checked the channel and
   * approved again has an adaptation that is `queued` — reading the old receipt
   * then would label a send that is in flight right now with the verdict of the
   * one before it. And `status <> 'in_flight'` picks the last FINISHED attempt:
   * a claim is written before the platform is called, so it is a record that
   * someone is sending, not a record of how it ended.
   */
  deliveryOutcome: sql<DeliveryOutcome>`(
    case
      when adaptations.status = 'failed' and (
        select p.status from publications p
        where p.adaptation_id = adaptations.id and p.status <> 'in_flight'
        order by p.created_at desc
        limit 1
      ) = 'unknown'
      then 'unknown'
      else adaptations.status
    end
  )`,
};

/**
 * The columns `get` needs to answer "which sentences are still the AI's" —
 * which level a version belongs to, its text, and whether that text is a whole
 * body or a refine's fragment. Nothing wider: the caller dims sentences, and a
 * version's title, run, author and timestamp would be payload nobody reads and
 * an allowlist nobody could shrink again.
 *
 * `scope` and `unit_delta` are read but NOT returned. They answer the badge's
 * deletion clause on the server (`collectAiEvidence`): which row is the anchor,
 * and how many units each accepted refine replaced. The lens dims a sentence
 * that matches any `ai` row, and a fragment is dimmable text like any other, so
 * neither column crosses the wire.
 *
 * Read them TOGETHER or not at all. `scope` without `unit_delta` is the shape
 * that reads a successful *shorten* as a human deletion — the body is a unit
 * shorter than the anchor and nothing on the rows says why — which opens the
 * publish gate on an unread draft and captions the model's own words
 * "Human-edited".
 */
const AI_VERSION_COLUMNS = {
  adaptationId: schema.contentVersions.adaptationId,
  body: schema.contentVersions.body,
  scope: schema.contentVersions.scope,
  unitDelta: schema.contentVersions.unitDelta,
};

/** What the LENS needs of a version row: which level it belongs to, and its text. */
type LensVersionRow = { adaptationId: string | null; body: string };

/**
 * The evidence `allSentencesAi` judges ONE level against: every `ai` ROW, for
 * the mask and for the deletion clause's running expectation, and the first
 * `scope = 'full'` body, as that clause's anchor.
 *
 * Rows rather than bodies, and that is the whole of increment 2b-2's fix to
 * this file. The clause counts against the anchor PLUS the sum of the fragment
 * rows' `unit_delta`, so a caller that flattened these to `row.body` would be
 * handing over evidence that cannot say a refine replaced anything — and every
 * successful *shorten* would read as a human trimming the draft.
 *
 * The two are separate arguments there for a reason worth restating at every
 * call site, because getting it wrong is silent: `rows[0]` is NOT the full
 * row. Nothing makes a level's `full` row its oldest one — a fragment sorts
 * first at any level whose full row arrives later, a re-generation after a
 * refine being the obvious way — and counting a body's sentences against a
 * one-sentence fragment makes "at least as many sentences as the model wrote"
 * true for everything: the deletion clause becomes a no-op and every deletion
 * reads as untouched AI.
 */
type AiEvidence = { readonly rows: readonly AiVersionRow[]; readonly firstFullBody?: string };

/**
 * No rows at all: the fail-safe shape, spelled once and shared by every caller
 * that missed the map — hence `readonly`, so no consumer can push a body into
 * the value the next one reads.
 */
const NO_AI_EVIDENCE: AiEvidence = { rows: [], firstFullBody: undefined };

/**
 * Collects that evidence per level, from rows already ordered oldest-first.
 *
 * The order is the caller's job and every caller does it the same way
 * (`created_at, id`), because "first" is only meaningful under one — see
 * `aiVersionRows` for why the tiebreak is load-bearing. This function cannot
 * check that it was given one, which is why it is the only place that decides
 * what "first `full`" means: the gate, the item response and the queue all read
 * it from here rather than each picking a row for itself.
 */
function collectAiEvidence<K, R extends AiVersionRow>(
  rows: readonly R[],
  levelOf: (row: R) => K,
): Map<K, AiEvidence> {
  const byLevel = new Map<K, { rows: AiVersionRow[]; firstFullBody?: string }>();
  for (const row of rows) {
    const level = levelOf(row);
    const evidence = byLevel.get(level) ?? { rows: [], firstFullBody: undefined };
    evidence.rows.push(row);
    if (row.scope === "full" && evidence.firstFullBody === undefined) {
      evidence.firstFullBody = row.body;
    }
    byLevel.set(level, evidence);
  }
  return byLevel;
}

/**
 * The body a human save should be remembered by, or `null` for a save that is
 * not a new version of anything.
 *
 * Three ways to write no row, and each is a real request the product makes
 * constantly rather than a corner:
 *
 * - `undefined` — the field is not in this PATCH at all. A title-only edit
 *   leaves the body exactly as it was, and a version of an unchanged body is
 *   history of an edit nobody made.
 * - `null` — a cleared per-channel override. It removes text and writes none,
 *   and `content_versions.body` is `NOT NULL`: there is no row shape for "no
 *   body", and inventing one (the empty string, or the item body it now falls
 *   back to) would file text the author did not write as text they did.
 * - The same text — the Save button pressed twice, or a reflow. `isSameText`,
 *   and NOT `normalizeForComparison` on the whole body, which is what this used
 *   to be: that comparison collapses every whitespace run, so it cannot see the
 *   newline the splitter treats as a sentence boundary, while the gate and the
 *   badge (`allSentencesAi`) split first and can see nothing else. Swapping one
 *   U+000A for a space in line-structured copy was therefore invisible here and
 *   decisive there — the one edit that turns a 409 into an approved publish,
 *   filed as no edit at all. `isSameText` answers with BOTH lenses, so a save
 *   that moves the gate's verdict always leaves a row, and one that changes the
 *   text only for the history (a reorder) does too.
 *
 * `previous === null` is a change by construction — a first override where the
 * channel had none is new text, and there is nothing to compare it against.
 */
function humanVersionBody(previous: string | null, next: string | null | undefined): string | null {
  if (next === undefined || next === null) return null;
  if (previous === null) return next;
  return isSameText(previous, next) ? null : next;
}

/** The `ai` version bodies of one item, by level, oldest first. */
type AiVersionBodies = {
  item: string[];
  adaptations: Record<string, string[]>;
};

/**
 * Groups version rows by level: `null` is the master body, everything else
 * keys by adaptation.
 *
 * EVERY adaptation of the item gets a key, `[]` when it has no `ai` rows of its
 * own, so the web never has to tell "this channel has no AI text" apart from
 * "the response forgot to mention it" — and a human-written item, which has no
 * version rows at all, comes back as empty lists rather than as an error or a
 * missing field.
 */
function groupAiVersionBodies(adaptationIds: string[], rows: LensVersionRow[]): AiVersionBodies {
  const item: string[] = [];
  const adaptations: Record<string, string[]> = Object.fromEntries(
    adaptationIds.map((id) => [id, [] as string[]]),
  );
  for (const row of rows) {
    if (row.adaptationId === null) {
      item.push(row.body);
      continue;
    }
    // A version row cascades with its adaptation, so it can only ever name one
    // of the ids above; the fallback keeps the body rather than dropping it
    // silently if that ever stops being true.
    const bodies = adaptations[row.adaptationId] ?? [];
    bodies.push(row.body);
    adaptations[row.adaptationId] = bodies;
  }
  return { item, adaptations };
}

@Injectable()
export class ContentRepository {
  private readonly logger = new Logger(ContentRepository.name);

  constructor(
    private readonly queue: QueueService,
    /** The org's key for a call that names no provider — see `refineCredential`. */
    private readonly credentials: AiCredentialsRepository,
    /** Every network line of a refine, and nothing else — see `RefineCaller`. */
    private readonly refiner: RefineCaller,
  ) {}

  private async adaptationsFor(orgId: string, contentItemId: string) {
    return db
      .select(ADAPTATION_COLUMNS)
      .from(schema.adaptations)
      .where(
        and(
          eq(schema.adaptations.orgId, orgId),
          eq(schema.adaptations.contentItemId, contentItemId),
        ),
      );
  }

  /**
   * The item-level `ai` version evidence for many items at once, keyed by item.
   *
   * `list` needs the badge's answer for every card, and the badge's answer is
   * the gate's question asked of these rows. One `IN` query rather than a read
   * per item: this is already an N+1 for adaptations, and the cure for that is
   * not a second one.
   *
   * `adaptation_id IS NULL` because the card's badge is about the MASTER body.
   * A channel override's provenance is a detail of the item screen, and joining
   * an adaptation's AI text into the item's reference would compare a body
   * against text the adapter rewrote for a platform — which never matches, so
   * every card would read "human-edited".
   *
   * Ordered `created_at, id`, the same order as the gate's read and `get`'s,
   * because the badge's deletion clause counts against the FIRST `scope =
   * 'full'` row. This query deliberately had no `ORDER BY` while the badge
   * asked whether the body matched ANY row — "any" has no first — and the
   * moment it stopped asking that, an unordered read became a silently wrong
   * one: no order means no first full row, and picking whatever the planner
   * returned first makes the deletion clause a no-op.
   */
  private async itemAiEvidence(orgId: string, itemIds: string[]): Promise<Map<string, AiEvidence>> {
    if (itemIds.length === 0) return new Map();
    const rows = await db
      .select({
        contentItemId: schema.contentVersions.contentItemId,
        body: schema.contentVersions.body,
        scope: schema.contentVersions.scope,
        unitDelta: schema.contentVersions.unitDelta,
      })
      .from(schema.contentVersions)
      .where(
        and(
          eq(schema.contentVersions.orgId, orgId),
          inArray(schema.contentVersions.contentItemId, itemIds),
          isNull(schema.contentVersions.adaptationId),
          eq(schema.contentVersions.origin, "ai"),
        ),
      )
      .orderBy(asc(schema.contentVersions.createdAt), asc(schema.contentVersions.id));
    return collectAiEvidence(rows, (row) => row.contentItemId);
  }

  async list(orgId: string, status?: string) {
    if (status !== undefined && !(CONTENT_STATUSES as readonly string[]).includes(status)) {
      throw new BadRequestException(
        `Unknown status: ${status}. Expected one of: ${CONTENT_STATUSES.join(", ")}`,
      );
    }
    const where = status
      ? and(
          eq(schema.contentItems.orgId, orgId),
          // Safe: membership just verified above, so the widened `string` really is one
          // of the literal statuses drizzle's column type expects.
          eq(schema.contentItems.status, status as ContentStatus),
        )
      : eq(schema.contentItems.orgId, orgId);
    const items = await db.select(ITEM_COLUMNS).from(schema.contentItems).where(where);
    const aiEvidence = await this.itemAiEvidence(
      orgId,
      items.map((item) => item.id),
    );
    return Promise.all(
      items.map(async (item) => {
        // The gate's question, on the card. See `get` for why the badge is a
        // boolean the server computes rather than a comparison the browser runs.
        const evidence = aiEvidence.get(item.id) ?? NO_AI_EVIDENCE;
        return {
          ...item,
          bodyIsAiVerbatim: allSentencesAi(item.body, evidence.rows, evidence.firstFullBody),
          adaptations: await this.adaptationsFor(orgId, item.id),
        };
      }),
    );
  }

  /**
   * The `ai` version bodies of one item, both levels, oldest first.
   *
   * Same table, same org scoping and the same `created_at, id` order as the
   * publish gate's read in `requireHumanInvolvement`. The tiebreak is
   * load-bearing in both: the worker writes an item's versions and all its
   * adaptations' versions in ONE transaction, where `now()` — and therefore
   * `created_at` — is identical across them, so `created_at` alone is not a
   * total order and "oldest first" would be whatever the planner felt like.
   *
   * The same rows the gate reads, at a different grain rather than a different
   * reference. The lens dims a sentence that still matches ANY `ai` version;
   * the gate and the badge ask whether EVERY sentence does (`allSentencesAi`),
   * off this same list. `scope` and `unit_delta` come back too, because that
   * question's deletion clause counts against the level's first
   * `scope = 'full'` row plus what each accepted refine replaced — both read
   * here and NEITHER forwarded to the browser, which dims a fragment like any
   * other text.
   *
   * The `org_id` predicate is defence in depth rather than this endpoint's only
   * tenant boundary: `get` has already 404'd an item belonging to another org
   * before this runs. It is what keeps a version row written with the wrong
   * `org_id` from being served as this org's own text, and the repository
   * convention that every read is scoped is worth more than the one saved
   * predicate.
   */
  private aiVersionRows(orgId: string, contentItemId: string) {
    return db
      .select(AI_VERSION_COLUMNS)
      .from(schema.contentVersions)
      .where(
        and(
          eq(schema.contentVersions.orgId, orgId),
          eq(schema.contentVersions.contentItemId, contentItemId),
          eq(schema.contentVersions.origin, "ai"),
        ),
      )
      .orderBy(asc(schema.contentVersions.createdAt), asc(schema.contentVersions.id));
  }

  /**
   * The id of the run that produced this item, or `null` — the receipt's
   * address, in the reverse direction.
   *
   * On the ITEM's response rather than behind a `GET /api/runs?contentItemId=`
   * lookup, for three reasons. The item screen already reads this endpoint, and
   * polls it while a post is on its way out, so a property costs no extra round
   * trip while a second endpoint would be either polled alongside it or left to
   * go stale against the thing it describes. A lookup would also be a second
   * way to ask one question ("which run made this"), and this repository layer
   * answers each question in exactly one place on purpose. And this is a
   * PROPERTY of the item, not a collection: `pipeline_runs.content_item_id` is
   * written once, by one run's terminal write, so there is nothing to page or
   * filter.
   *
   * Ordered and limited all the same. The column carries no unique constraint,
   * so "at most one" is a fact about the writer rather than one the database
   * enforces, and an unordered read of a set that grew a second member would
   * hand back whichever row the planner reached first — a link that changed on
   * refresh. `created_at, id` is the same total order every other read here
   * uses, and the tiebreak is load-bearing for the same reason.
   *
   * `org_id` is in the predicate and is not decoration: the FK does not require
   * a run and its item to share an org, so without it an item could be made to
   * name a stranger's receipt.
   */
  private async runIdFor(orgId: string, contentItemId: string): Promise<string | null> {
    const rows = await db
      .select({ id: schema.pipelineRuns.id })
      .from(schema.pipelineRuns)
      .where(
        and(
          eq(schema.pipelineRuns.orgId, orgId),
          eq(schema.pipelineRuns.contentItemId, contentItemId),
        ),
      )
      .orderBy(asc(schema.pipelineRuns.createdAt), asc(schema.pipelineRuns.id))
      .limit(1);
    return rows[0]?.id ?? null;
  }

  async get(orgId: string, id: string) {
    const rows = await db
      .select(ITEM_COLUMNS)
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .limit(1);
    const item = rows[0];
    if (!item) throw notFound("content_not_found", "Content item not found");
    // Two independent reads of the same item, issued together: this method is
    // the response of every mutation on the resource as well as of the GET, so
    // it pays for its round trips more often than any other read here.
    const [adaptations, aiVersions, runId, refineProposal] = await Promise.all([
      this.adaptationsFor(orgId, item.id),
      this.aiVersionRows(orgId, item.id),
      this.runIdFor(orgId, item.id),
      this.stagedProposal(orgId, item.id),
    ]);
    /**
     * The provenance lens's reference text. Returned rather than a
     * server-computed mask because the browser would have to split the
     * current text identically to align a mask to it anyway (provenance-lens spec §4), and
     * two splitters that must agree are two splitters that will stop
     * agreeing.
     */
    const aiVersionBodies = groupAiVersionBodies(
      adaptations.map((adaptation) => adaptation.id),
      aiVersions,
    );
    /**
     * The badge's evidence, at the MASTER level — the same rows the lens is
     * handed, plus the `scope` the browser has no use for. Through
     * `collectAiEvidence` rather than a `find` here, so that "the first full
     * row" is decided in one place for the gate, the item and the queue alike.
     */
    const itemEvidence =
      collectAiEvidence(aiVersions, (row) => row.adaptationId).get(null) ?? NO_AI_EVIDENCE;
    return {
      ...item,
      adaptations,
      /**
       * The run that made this item, so the delivery receipt stays reachable
       * from the finished draft (dossier §6.3). `null` for a hand-written item
       * — the ordinary case — and for one whose run row is gone.
       */
      runId,
      /**
       * The origin badge's answer — computed here rather than in the browser,
       * because the QUEUE has to be able to give it too and the queue has no
       * reference text to compute it from (see `itemAiEvidence`). Before this
       * field, a rewritten item's card read "AI-drafted" while its own detail
       * screen said "Human-edited" one click later, which is the exact claim
       * the provenance-lens design's §5 leans on to ship the lens off by default: the badge already
       * carries it at a glance on every card.
       *
       * The gate's own question (`allSentencesAi`, authorship-per-sentence spec §2), off the same rows
       * the lens dims against, so the badge and the gate cannot give one screen
       * two answers. Whole-body equality could not: a refine's fragment never
       * EQUALS a whole body, so an accepted proposal made the badge caption the
       * model's own words "Human-edited" while the gate refused the same draft.
       * Fail-safe included: no version rows, or none with `scope = 'full'`,
       * means `true` — an item whose reference was never written keeps reading
       * AI-drafted instead of over-claiming an edit nobody made.
       */
      bodyIsAiVerbatim: allSentencesAi(item.body, itemEvidence.rows, itemEvidence.firstFullBody),
      /**
       * THE SUGGESTION THIS DRAFT HAS STAGED, or `null` — the read path that
       * makes a refine survive a reload.
       *
       * A press is paid for the moment its row is written, and without this
       * field the only copy of it anyone ever saw was the 201 in one browser
       * tab: a reload, a crash or a second device stranded a row nothing could
       * reach, on a screen showing the very draft it was written against.
       *
       * HERE rather than behind a `GET /:id/refine`, for the reason `runId`
       * gives one field up and with more force. This endpoint is the one the
       * item screen already reads and polls, so a property costs no round trip,
       * while a second endpoint would be either polled beside this one or left
       * to go stale — and stale against exactly the body the proposal's anchor
       * is re-located in. One request, one answer, and the card and the draft
       * cannot disagree about which draft it is.
       *
       * Deliberately NOT on the list rows. A queue card never draws a
       * suggestion, and a list that carried them would ship every staged
       * proposal in the organisation to render cards that do not mention them —
       * the same argument that keeps `aiVersionBodies` off the list.
       */
      refineProposal,
      aiVersionBodies,
    };
  }

  /**
   * The one proposal staged for this draft, or `null`.
   *
   * `LIMIT 1` with no ordering is exact rather than lucky: `refine_proposals`
   * is UNIQUE on `content_item_id`, so there is at most one row to find, and a
   * second could not exist for an order to have to choose between.
   *
   * On the pool, not in a transaction, because its only caller is `get` — a
   * read. Accept reads the row again, under its own lock, and never off this
   * one: a proposal read outside the lock could be superseded between the read
   * and the splice.
   *
   * `org_id` is in the predicate as defence in depth, exactly as
   * `aiVersionRows` carries one: `get` has already 404'd another org's item
   * before this runs, and what this predicate keeps out is a row written with
   * the wrong `org_id` being served as this org's own.
   */
  private async stagedProposal(
    orgId: string,
    contentItemId: string,
  ): Promise<RefineProposal | null> {
    const rows = await db
      .select(PROPOSAL_COLUMNS)
      .from(schema.refineProposals)
      .where(
        and(
          eq(schema.refineProposals.orgId, orgId),
          eq(schema.refineProposals.contentItemId, contentItemId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  async create(orgId: string, data: ContentCreate) {
    const channels = await db
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.orgId, orgId),
          eq(schema.channels.brandId, data.brandId),
          inArray(schema.channels.id, data.channelIds),
        ),
      );
    if (channels.length !== data.channelIds.length) {
      throw notFound("channels_not_in_brand", "One or more channels do not belong to this brand");
    }

    const id = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(schema.contentItems)
        .values({ orgId, brandId: data.brandId, title: data.title ?? null, body: data.body })
        .returning({ id: schema.contentItems.id });
      const itemId = inserted[0]?.id as string;
      await tx
        .insert(schema.adaptations)
        .values(
          channels.map((channel) => ({ orgId, contentItemId: itemId, channelId: channel.id })),
        );
      return itemId;
    });

    return this.get(orgId, id);
  }

  /**
   * 404s an item that does not exist in this org, 409s one whose text approval
   * has already pinned (see `EDITABLE_ITEM_STATUSES`), and holds the row lock
   * for the rest of the caller's transaction so the verdict cannot go stale
   * between the check and the write.
   *
   * Taking a `content_items` lock is only safe here because the edit paths
   * lock nothing else afterwards, and because `updateAdaptation` (which does
   * lock both) takes the `adaptations` lock first — the same order as
   * `approve`/`reject` and the worker (see `lockAdaptations`).
   *
   * Returns the body it locked, because `update` has to know whether this save
   * actually changed the text. Read here rather than in a second SELECT: the
   * lock is already held, so this is the one read that cannot be stale by the
   * time the write lands — and a version row written against a body some other
   * transaction had already replaced would record an edit that never happened.
   */
  private async requireEditableItem(tx: Tx, orgId: string, id: string): Promise<{ body: string }> {
    const rows = await tx
      .select({ status: schema.contentItems.status, body: schema.contentItems.body })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .limit(1)
      .for("update");
    const item = rows[0];
    if (!item) throw notFound("content_not_found", "Content item not found");
    const pinned = pinnedItemRefusal(item.status);
    if (pinned) throw pinned;
    return { body: item.body };
  }

  /**
   * The author's own save, kept — a `full` row, `origin: 'human'`, stamped with
   * the user who typed it.
   *
   * Until this existed, exactly one thing wrote `content_versions`: the
   * worker's terminal write, always `origin: 'ai'`. No human action wrote a row
   * at all, so a version history had nothing to list and Restore nothing to
   * restore to.
   *
   * `scope: 'full'` because a save replaces the whole body; `fragment` belongs
   * to a refine's accepted proposal. `title` is left null, exactly as the
   * worker's own rows leave it: a row is written only when the BODY changed, so
   * a title carried along here would be a title history with every title-only
   * save missing from it.
   *
   * Called INSIDE the caller's transaction, after the body write and under the
   * locks the caller already holds, so a refused edit leaves no history of
   * itself.
   *
   * **An INSERT here is a lock on both FK targets, and the invariant is that
   * the caller already holds them.** An earlier draft of this comment claimed
   * the insert "adds no new lock to the documented order"; that is not what a
   * foreign key does. Postgres takes `FOR KEY SHARE` on every referenced row —
   * `content_items`, and the adaptation when `adaptationId` is set — and it is
   * a real lock, measured rather than reasoned about: in psql it waited 3.1 s
   * behind a concurrent `SELECT ... FOR UPDATE` on the parent, and two
   * transactions deadlock outright when one locks `content_items` first and
   * then inserts an adaptation-level row while the other holds the adaptation.
   *
   * The claim happens to be TRUE of both callers today, and only because of
   * what they lock: `update` writes `adaptationId: null` under the item's own
   * `FOR UPDATE`, and `updateAdaptation` takes the adaptation's `FOR UPDATE`
   * BEFORE the item's (`lockAdaptations`' order), so in both cases every row
   * this insert touches is already held in a strictly stronger mode and the
   * FK's own lock is a no-op.
   *
   * So the rule a future writer has to keep is not "this is free" but:
   *
   *   **An adaptation-level version row may only be written from a transaction
   *   that ALREADY holds that adaptation's `FOR UPDATE`.**
   *
   * 2b-2's "refine an override" is the obvious way to break it — a path that
   * locks the item, calls the model, and files a `fragment` row against an
   * adaptation it never locked takes `content_items` before `adaptations`,
   * which is precisely the inversion `lockAdaptations` documents as a genuine
   * deadlock against the worker's `markPublished`.
   *
   * Invisible to every read that asks about provenance: the gate, the origin
   * badge and the lens all filter `origin = 'ai'`, because a version the author
   * typed is not evidence that the model wrote a sentence.
   */
  private async recordHumanVersion(
    tx: Tx,
    row: {
      orgId: string;
      contentItemId: string;
      adaptationId: string | null;
      body: string;
      createdBy: string;
    },
  ): Promise<void> {
    await tx.insert(schema.contentVersions).values({ ...row, origin: "human", scope: "full" });
  }

  async update(orgId: string, id: string, data: ContentUpdate, userId: string) {
    await db.transaction(async (tx) => {
      const current = await this.requireEditableItem(tx, orgId, id);
      await tx
        .update(schema.contentItems)
        .set(data)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)));
      const versionBody = humanVersionBody(current.body, data.body);
      if (versionBody !== null) {
        await this.recordHumanVersion(tx, {
          orgId,
          contentItemId: id,
          adaptationId: null,
          body: versionBody,
          createdBy: userId,
        });
      }
    });
    return this.get(orgId, id);
  }

  /**
   * ASK THE MODEL TO REVISE ONE SELECTION, AND STAGE WHAT IT SAID.
   *
   * This is the first route in the product a person can make spend money
   * REPEATEDLY, BY HAND, on content, so the order of what happens here is the
   * design rather than an implementation detail:
   *
   *  1. **Everything that can refuse for free, first.** The item exists, is
   *     still editable, the range is inside its body, a model wrote this draft,
   *     the hour's allowance is not spent, and there is a key to spend it with.
   *     Every one of these is checked before a provider is contacted, and the
   *     e2e asserts the caller was never invoked rather than merely that the
   *     response was a 409 — "refused after paying" is the failure that costs
   *     somebody money.
   *  2. **The call, with NO transaction open.** See below.
   *  3. **The ledger, then the row.** The money is recorded before anything
   *     decides whether the answer was usable, because it was spent either way.
   *
   * **NO LOCK IS HELD ACROSS THE CALL, and that is a deliberate deviation from
   * increment 2b-1's "both Accept and the refine call itself take
   * `requireEditableItem` first".** `requireEditableItem` takes
   * `SELECT … FOR UPDATE`; holding it across a forty-five-second model call
   * would hold a row lock AND a pool connection for forty-five seconds, which
   * is pool exhaustion at exactly the concurrency it is meant to permit — the
   * argument the product already makes about `pg_advisory_xact_lock`. So the
   * editability read here is an ordinary `SELECT` with the same predicate and
   * no lock.
   *
   * What that costs is stated rather than overlooked: the read can go stale, so
   * a draft approved while the model was answering yields a proposal against an
   * item that is now pinned. Accept re-checks under the lock and refuses, the
   * proposal SURVIVES that refusal as a row, and rejecting the item and
   * accepting the proposal loses nothing. The alternative — refusing to stage a
   * paid-for proposal because the state moved — throws away money to avoid an
   * inconvenience.
   *
   * **A DOUBLE PRESS.** Two presses on one draft are two calls and two ledger
   * rows: the money is bounded by the allowance, not by press-deduplication,
   * and pretending otherwise would need a lease whose expiry nothing can
   * observe (see the table's own docstring). What they cannot do is leave two
   * proposals — `refine_proposals` is unique on `content_item_id` and the stage
   * below deletes before it inserts, so the later insert supersedes rather than
   * accumulating. The screen shows one card because the database holds one row.
   */
  async refine(
    orgId: string,
    id: string,
    userId: string,
    request: RefineRequest,
  ): Promise<RefineProposal> {
    const item = await this.refinableItem(orgId, id);
    const selection = selectionOf(item.body, request);
    await this.requireAiDraft(orgId, id);
    if (await this.overRefineBudget(orgId)) {
      throw conflict(
        "refine_limit_reached",
        `This organization has already made ${MAX_REFINE_CALLS_PER_HOUR} refine calls in the last hour`,
      );
    }
    const credential = await this.refineCredential(orgId);
    const brand = await this.brandFor(orgId, item.brandId);

    const outcome = await this.refiner.run({
      credential,
      brand,
      verb: request.verb,
      // The body, cut at the splice offsets and never overlapping: the model is
      // shown every surrounding word and exactly one copy of the selection.
      input: {
        selection,
        before: item.body.slice(0, request.start),
        after: item.body.slice(request.end),
      },
    });

    // BEFORE the verdict, and for the failed verdict too: the provider counts
    // tokens before it knows whether we could parse the answer, so a refine
    // that ends in a 409 can still have cost money. A ledger that recorded only
    // the answers we liked would understate the org's spend AND hand this
    // route's own allowance a count that misses the calls most worth counting.
    await this.recordRefineUsage(orgId, id, outcome.usage);
    if (!outcome.ok) {
      throw conflict(REFINE_FAILURE_CODE[outcome.failure], REFINE_FAILURE_MESSAGE[outcome.failure]);
    }

    /**
     * THE PROPOSE-TIME BOUND ON THE MERGED BODY, which nothing before this line
     * applies. `refineOutputSchema.text` bounds the REPLACEMENT by
     * `MAX_BODY_LENGTH` and says so: it never sees the body or the offsets, so
     * a near-full body and a full-length reply both pass it. Without this check
     * the pair would be staged as a proposal that `planRefineAccept` can only
     * ever answer `too_long` to — a card the person reads, presses Accept on,
     * and is refused by, after the call was paid for.
     *
     * Measured the way Accept measures it: `normalizeNewlines` first (the DTO's
     * own rule — the limit bounds what gets STORED, and a model's CRLF is a
     * character the product is about to drop), the splice second. Accept checks
     * again rather than trusting this one, because the body can grow between
     * propose and accept; this is the first line of defence and that is the
     * second.
     */
    const proposal = normalizeNewlines(outcome.text);
    const merged = item.body.slice(0, request.start) + proposal + item.body.slice(request.end);
    if (merged.length > MAX_BODY_LENGTH) {
      throw conflict(
        "refine_too_long",
        `Applying this suggestion would make the post longer than ${MAX_BODY_LENGTH} characters`,
      );
    }

    return this.stageProposal({
      orgId,
      contentItemId: id,
      createdBy: userId,
      verb: request.verb,
      selectedText: selection,
      startOffset: request.start,
      endOffset: request.end,
      proposal,
      reason: outcome.reason,
    });
  }

  /**
   * The item a refine is about — read WITHOUT a lock, and refused on exactly
   * the same predicate `requireEditableItem` refuses on.
   *
   * The two share `pinnedItemRefusal` rather than each testing the status,
   * because a refine that could be proposed against text an approval has
   * pinned is a refine whose Accept can only ever be refused: one predicate,
   * two readings of it, no room for them to answer differently.
   *
   * Returns the BRAND as well as the body: the model is told the brand's voice,
   * audience and content language, and `instructionsFor` emits that language
   * directive on every call — a refine that skipped it would answer a French
   * draft in English.
   */
  private async refinableItem(
    orgId: string,
    id: string,
  ): Promise<{ body: string; brandId: string }> {
    const rows = await db
      .select({
        status: schema.contentItems.status,
        body: schema.contentItems.body,
        brandId: schema.contentItems.brandId,
      })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .limit(1);
    const item = rows[0];
    if (!item) throw notFound("content_not_found", "Content item not found");
    const pinned = pinnedItemRefusal(item.status);
    if (pinned) throw pinned;
    return { body: item.body, brandId: item.brandId };
  }

  /**
   * REFUSE A DRAFT THE MODEL HAS NEVER WRITTEN, and this is a decision rather
   * than an omission.
   *
   * A hand-typed post has no `ai` `full` version row, and refining one has no
   * honest outcome available today. Leaving `origin = 'human'` makes the badge
   * say "Human-written" over the model's sentence — `deriveOrigin` returns
   * before `bodyIsAiVerbatim` is ever read on that branch. Flipping it to `ai`
   * gives the level fragment-only evidence, which takes the missing-evidence
   * branch and refuses the draft with `unread_ai_draft_open_only` until
   * somebody opens it. And the deletion clause has no anchor at that level
   * EVER, so the very clause this increment exists to fix cannot run there.
   *
   * Making it honest needs a fifth badge value — "a human wrote this and the
   * model touched part of it" — plus an anchor for the count that is not an
   * `ai` row. Both re-open increment 2b-1's settled surface for a use the
   * flagship path does not need, so the refusal names the case instead.
   *
   * The MASTER level only (`adaptation_id IS NULL`): this increment does not
   * refine a per-channel override, and an adaptation's own `ai` row would say
   * nothing about the body being refined here.
   */
  private async requireAiDraft(orgId: string, id: string): Promise<void> {
    const rows = await db
      .select({ id: schema.contentVersions.id })
      .from(schema.contentVersions)
      .where(
        and(
          eq(schema.contentVersions.orgId, orgId),
          eq(schema.contentVersions.contentItemId, id),
          isNull(schema.contentVersions.adaptationId),
          eq(schema.contentVersions.origin, "ai"),
          eq(schema.contentVersions.scope, "full"),
        ),
      )
      .limit(1);
    if (rows.length === 0) {
      throw conflict(
        "refine_needs_ai_draft",
        "This post was written by hand; the refine verbs work on a draft the model wrote",
      );
    }
  }

  /**
   * Has this org used up its hourly allowance of billed refine calls?
   *
   * `AiCredentialsRepository.overTestBudget`'s design, deliberately, down to
   * the reasons — and NOT its budget. That one counts `step = 'test'` and this
   * one `step = 'refine'`, so neither button can spend the other's allowance:
   * a person out of Test presses can still refine, and a generation run's dozen
   * calls do not lock the editor. `REFINE_STEP` is imported rather than spelled
   * out here, because the two ends of that filter — the step's own name and
   * this predicate — must be the same string for the limit to bound anything
   * at all.
   *
   * COUNTED FROM THE LEDGER the calls themselves wrote, so: the number is the
   * same for every api replica and survives a restart (an in-process bucket is
   * one budget per replica and a fresh one after each deploy, which is a limit
   * an attacker waits out); a press that cost two physical calls consumes two,
   * because the ledger wrote two, so what is bounded is money and not clicks;
   * and a refine that spent nothing — refused before the provider — consumes
   * nothing.
   *
   * A SQL-literal interval rather than a JavaScript `Date`, for the reason
   * `TEST_BUDGET_WINDOW` documents: `usage_ledger.created_at` is `timestamp`
   * WITHOUT time zone written by the database's own `now()`, and handing it a
   * `Date` from a replica in another zone would shift the window by the offset
   * — waving every request through, or refusing every one.
   *
   * NO LOCK. Two presses that read the count at the same instant can both pass;
   * the overshoot is the concurrency, not a multiple of the limit, and that
   * holds only because `maxRetries: 0` bounds a press at two rows. A
   * `SELECT … FOR UPDATE` over the window would serialise every press in the
   * deployment to save a call worth a fraction of a cent.
   *
   * `>=`, not `>`: the count is of calls ALREADY MADE, so a count that has
   * reached the limit means the allowance is spent.
   */
  private async overRefineBudget(orgId: string): Promise<boolean> {
    const rows = await db
      .select({ calls: sql<string>`count(*)` })
      .from(schema.usageLedger)
      .where(
        and(
          eq(schema.usageLedger.orgId, orgId),
          eq(schema.usageLedger.step, REFINE_STEP),
          sql`${schema.usageLedger.createdAt} > now() - ${REFINE_BUDGET_WINDOW}`,
        ),
      );
    // `count(*)` over zero rows still returns one row holding 0; this guards
    // the type, not a case Postgres produces.
    return Number(rows[0]?.calls ?? 0) >= MAX_REFINE_CALLS_PER_HOUR;
  }

  /**
   * The key this call will be billed to, or the refusal that says there is
   * none.
   *
   * `refine_no_credential` is separated from `refine_failed` because it is the
   * one the reader can act on — it sends them to Settings — and folding it into
   * a generic sentence would be the "one honest sentence for four different
   * faults" mistake `API_ERROR_CODES` argues against.
   *
   * A blob that will not DECRYPT is a different event and is answered
   * `refine_failed`, with the operator's half in the log. It is not
   * `no_credential` (there is a key; the row is right there on the Settings
   * screen), it is not a 500 (nothing is broken about this request, and the
   * cause is a real one — `APP_ENCRYPTION_KEY` rotated under a stored row), and
   * this route has no member for it: a verdict about a stored key belongs to
   * the Test button, which has one and can say `unreadable_key` in four
   * languages. What this owes the reader is that their refine did not happen
   * and nothing was charged for it.
   */
  private async refineCredential(orgId: string): Promise<AiCredential> {
    let credential: AiCredential | undefined;
    try {
      credential = await this.credentials.credential(orgId);
    } catch (error) {
      if (!isUnreadableCiphertext(error) && !isMalformedStoredAiCredential(error)) throw error;
      this.logger.error(
        `Refine on content item of org ${orgId} could not read the stored API key: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          "Test the key in Settings for a verdict about it.",
      );
      throw conflict(REFINE_FAILURE_CODE.failed, REFINE_FAILURE_MESSAGE.failed);
    }
    if (!credential) {
      throw conflict(
        "refine_no_credential",
        "This organization has no AI provider key stored; add one in Settings",
      );
    }
    return credential;
  }

  /** The brand's voice, audience and content language, in the shape a step takes. */
  private async brandFor(orgId: string, brandId: string): Promise<StepBrand> {
    const rows = await db
      .select({
        name: schema.brands.name,
        voice: schema.brands.voice,
        audience: schema.brands.audience,
        contentLanguage: schema.brands.contentLanguage,
      })
      .from(schema.brands)
      .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, brandId)))
      .limit(1);
    const brand = rows[0];
    if (!brand) throw notFound("brand_not_found", "Brand not found");
    return brand;
  }

  /**
   * One ledger row per physical call, attributed to the DRAFT rather than to a
   * run.
   *
   * `run_id` is null and `content_item_id` is set — the column migration 0006
   * added for exactly this caller and that nothing has written since. Without
   * it, "what did refining this draft cost" would have no answer at all, since
   * a refine belongs to no run. `adaptation_id` stays null: this increment does
   * not refine a per-channel override.
   *
   * `step` and `channel_id` come from the STEP's own attribution, never from
   * this method — the same rule the worker's `recordUsage` follows, and here it
   * is also what keeps the hourly allowance's filter honest, since the count
   * reads the string the step wrote.
   *
   * A FAILED INSERT DOES NOT FAIL THE REQUEST. Losing the record of a billed
   * call is bad; throwing away the answer already paid for as well is strictly
   * worse, and a 500 here would do both. Same rule `AiCredentialsRepository`
   * and `generateStructured`'s `onUsageError` follow: shout, keep the result.
   * The message names what the org's total is now missing.
   *
   * ONE failure is narrowed rather than merely shouted about, because it is
   * reachable rather than exotic: the draft can be deleted while the model is
   * answering (a refine spends forty-five seconds outside any transaction, and
   * a brand delete cascades into `content_items`), and the money was still
   * spent. The rows are then written with `content_item_id` null — see below.
   */
  private async recordRefineUsage(
    orgId: string,
    contentItemId: string,
    usage: readonly RefineUsage[],
  ): Promise<void> {
    if (usage.length === 0) return;
    const rows = usage.map(({ record, attribution }) => ({
      orgId,
      runId: null,
      step: attribution.step,
      channelId: attribution.channelId ?? null,
      contentItemId,
      adaptationId: null,
      attempt: record.attempt,
      provider: record.provider,
      modelId: record.modelId,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      cachedInputTokens: record.cachedInputTokens,
      reasoningTokens: record.reasoningTokens,
      // `numeric(12,6)` is a string column in drizzle, and the conversion
      // is not `String(cost)`: `toLedgerCostUsd` floors a real
      // sub-micro-dollar cost so a billed call never stores 0.000000.
      costUsd: toLedgerCostUsd(record.costUsd),
      costSource: record.costSource,
      status: record.status,
      // What became of the round trip. A zero-token row is written by a 429
      // AND by a call lost after dispatch; this is the only column that
      // says which, and `spend()` reads it to decide whether the org's
      // total is a floor.
      outcome: record.outcome,
      responseMs: record.responseMs,
      keyOwnership: "byok" as const,
    }));
    try {
      await db.insert(schema.usageLedger).values(rows);
    } catch (error) {
      if (isForeignKeyViolation(error)) {
        // The DRAFT went while the model was answering — a deleted brand
        // cascades into `content_items` — and the money was still spent.
        // `content_item_id` is `ON DELETE SET NULL` precisely so a tidy-up
        // cannot erase spend history, and the org's total sums by `org_id`
        // ALONE, so the rows are written without the reference they can no
        // longer satisfy rather than dropped on the floor. What is lost is the
        // answer to "what did refining THAT draft cost", which no longer has a
        // draft to be about; what is kept is the org's bill, and the allowance
        // that bounds it.
        this.logger.warn(
          `Content item ${contentItemId} disappeared before its ${REFINE_STEP} ledger row(s) ` +
            `could be written; recording the spend with content_item_id=null. orgId=${orgId}`,
        );
        try {
          await db
            .insert(schema.usageLedger)
            .values(rows.map((row) => ({ ...row, contentItemId: null })));
          return;
        } catch (retryError) {
          this.logger.error(
            `USAGE RECORDING FAILED after narrowing: ${rows.length} billed call(s) are missing from this org's spend. ` +
              `orgId=${orgId} error=${retryError instanceof Error ? retryError.message : String(retryError)}`,
          );
          return;
        }
      }
      this.logger.error(
        `USAGE RECORDING FAILED: ${usage.length} billed ${usage[0]?.record.provider} call(s) could not be written to the ledger — ` +
          `this org's spend is understated by them, and its refine allowance will not count them. ` +
          `orgId=${orgId} contentItemId=${contentItemId} step=${REFINE_STEP} ` +
          `error=${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Write the proposal down, superseding whatever was staged for this draft.
   *
   * DELETE THEN INSERT, in one transaction, rather than an upsert: the row a
   * person is looking at and the row this call stages are different proposals,
   * with different text, a different verb and a different range, and giving
   * them one identity would let an Accept aimed at the first apply the second.
   * A new `id` per proposal is what makes a stale Accept a 404 instead of a
   * surprise.
   *
   * The delete is keyed on `content_item_id` ALONE — the unique index's own
   * column, so it removes exactly the row the insert below could collide with.
   * Adding `org_id` would not be stricter: tenancy was checked above against
   * the item, an item belongs to one org, and the row's `org_id` is always that
   * item's, so the two predicates select the same row (a mutation that adds it
   * survives the suite, which is the evidence). What it would be is a predicate
   * narrower than the constraint it exists to satisfy.
   *
   * WHAT THIS TRANSACTION LOCKS, for `docs/lock-order.md`: `content_items`
   * first, then the item's existing proposal row — plus `organization` and
   * `user` through the insert's other two foreign keys, neither of which any
   * transaction takes together with anything else. That order is the product's,
   * and `insertProposal` below takes it deliberately rather than as a side
   * effect. The model call is already over by the time this opens.
   */
  private async stageProposal(row: {
    orgId: string;
    contentItemId: string;
    createdBy: string;
    verb: RefineVerb;
    selectedText: string;
    startOffset: number;
    endOffset: number;
    proposal: string;
    reason: string;
  }): Promise<RefineProposal> {
    let staged: RefineProposal | undefined;
    try {
      staged = await this.insertProposal(row);
    } catch (error) {
      // The draft went while the model was answering. Not a 500: the request
      // was well formed, the cause is nameable, and `content_not_found` is the
      // sentence a reader can act on — the same one every other read of a
      // deleted item gives them.
      if (!isForeignKeyViolation(error)) throw error;
      throw notFound("content_not_found", "Content item not found");
    }
    // `INSERT … RETURNING` of one row returns one row; this guards the type.
    if (!staged) throw new Error("refine proposal was not staged");
    return staged;
  }

  /**
   * THE ITEM FIRST, THEN ITS PROPOSAL ROW — `docs/lock-order.md`'s order, taken
   * here rather than left to the insert's foreign key.
   *
   * Without this statement the acquisition order is the inverse: the `DELETE`
   * locks the proposal row and `content_items FOR KEY SHARE` arrives four
   * statements later, inside the insert. Both of the transactions that touch
   * these two rows go the other way — a brand delete's cascade destroys the
   * item and then its proposal children, and Accept locks the item `FOR UPDATE`
   * and then reads the proposal under it — so the inverse order is a cycle, and
   * it was reproduced as `40P01` against a real database from both sides. A
   * deadlock here is expensive in a way a deadlock usually is not: the model
   * call is paid for and the ledger row written before this opens, and `40P01`
   * is not `23503`, so it reached the reader as a 500 with no proposal.
   *
   * `FOR NO KEY UPDATE`, not `FOR KEY SHARE`, and the difference is the second
   * defect this closes. `FOR KEY SHARE` would order the acquisition and nothing
   * else: two presses could hold it at once, both delete a row neither can see,
   * and the second would be answered `duplicate key` — a 500 for a call the
   * person had already paid for. `FOR NO KEY UPDATE` is the weakest mode two
   * holders cannot share, so two overlapping presses queue on the item and the
   * later one supersedes the earlier, which is exactly what two sequential
   * presses do. Serialising them is preferred to catching `23505` and retrying:
   * a retry can lose the same race again to a third press, and "supersede" is
   * easier to reason about when it is a total order rather than a rule with an
   * exception. What the lock cannot order is a press against an api replica
   * still running the build before this one, which takes no such lock — a
   * window that closes when that replica goes, and not worth a recovery path
   * nothing afterwards can reach.
   *
   * It is deliberately NOT `requireEditableItem`'s `FOR UPDATE`: this
   * transaction does not change the item, and `FOR NO KEY UPDATE` leaves the
   * foreign-key `FOR KEY SHARE` that `content_versions` and `usage_ledger`
   * inserts take unblocked.
   *
   * NO ROW is not an error here. The draft can be deleted while the model is
   * answering; the insert then violates its foreign key and `stageProposal`
   * turns that into 404 `content_not_found`, which is the one answer this case
   * has ever had. Throwing from here instead would leave that arm unreachable
   * and untested.
   */
  private async insertProposal(row: {
    orgId: string;
    contentItemId: string;
    createdBy: string;
    verb: RefineVerb;
    selectedText: string;
    startOffset: number;
    endOffset: number;
    proposal: string;
    reason: string;
  }): Promise<RefineProposal | undefined> {
    return db.transaction(async (tx) => {
      await tx
        .select({ id: schema.contentItems.id })
        .from(schema.contentItems)
        .where(
          and(
            eq(schema.contentItems.orgId, row.orgId),
            eq(schema.contentItems.id, row.contentItemId),
          ),
        )
        .limit(1)
        .for("no key update");
      await tx
        .delete(schema.refineProposals)
        .where(eq(schema.refineProposals.contentItemId, row.contentItemId));
      // The same allowlist `get` reads the row back through, so the 201 of a
      // press and the `refineProposal` a reload finds are the same shape.
      const rows = await tx.insert(schema.refineProposals).values(row).returning(PROPOSAL_COLUMNS);
      return rows[0];
    });
  }

  /**
   * APPLY A PROPOSAL THE ORGANISATION HAS ALREADY PAID FOR, and record that a
   * MODEL wrote the sentences it introduced.
   *
   * One transaction, in the product's own lock order — `content_items`
   * `FOR UPDATE` through `requireEditableItem`, then the proposal row under it
   * — and every write in it or none:
   *
   * ```
   * requireEditableItem      -- the lock, and the body to splice into
   * read the proposal        -- org- AND item-scoped; 404 if it is gone
   * re-locate the anchor     -- 409 refine_anchor_lost if the text moved away
   * read the level's ai rows -- IN THIS TRANSACTION; see below
   * planRefineAccept         -- 409, and the proposal SURVIVES, or:
   *   unchanged -> delete the proposal, change nothing else
   *   ok        -> update the body, file the fragment row, delete the proposal
   * ```
   *
   * **THE `ai` ROWS ARE READ INSIDE THIS TRANSACTION**, never through
   * `aiVersionRows`, which runs on the pool. The rows decide whether the
   * characters a merged sentence absorbs came from text a model wrote, and
   * that verdict must be computed against the same rows this transaction is
   * about to add one to.
   *
   * The mechanism is the LOCK, not the transaction, and an earlier draft of
   * this comment got it wrong in a way worth correcting rather than deleting:
   * it said a pool read would see "a body another transaction had already
   * replaced". This database is `read committed` (nothing in `packages/db`
   * sets an isolation level), so a statement issued on the pool and one issued
   * here take the same kind of fresh snapshot — being inside the transaction
   * buys no stability by itself. What excludes a concurrent writer is the
   * `content_items FOR UPDATE` this transaction already holds, and every
   * writer of these rows takes that item first (enumerated below). The
   * correction matters because the reason as first written would let a future
   * reader conclude the `FOR UPDATE` is the redundant half.
   *
   * The MASTER level only (`adaptation_id IS NULL`). This increment does not
   * refine a per-channel override, and an adaptation's own `ai` rows say
   * nothing about the body being spliced here — see `recordHumanVersion` on why
   * a fragment filed against an adaptation this transaction never locked would
   * be the product's documented lock inversion.
   *
   * ⚠ Moving that read to the pool SURVIVES the suite (measured, `--runs 3`),
   * and the line stays as it is with the measurement written beside it, the way
   * `requireHumanInvolvement`'s own `.for("update")` does. It survives for a
   * reason that is itself a lock argument rather than a gap in the tests: every
   * writer of these rows takes `content_items` first, and this transaction
   * holds it `FOR UPDATE`, so while we are here there is no concurrent writer
   * for the two reads to disagree about. Enumerated rather than assumed —
   * `content_versions` has exactly three writers, and no `UPDATE` or `DELETE`
   * of one exists anywhere: `recordHumanVersion` (always `origin: 'human'`,
   * which this read filters out anyway, and taken under the item's own lock),
   * this method's own insert, and the worker's terminal write, which CREATES
   * the `content_items` row in the same transaction and so cannot race an
   * Accept on it. That is a fact about the CURRENT lock
   * discipline, not about this method — a future writer of `content_versions`
   * that did not take the item would make the pool read wrong, silently and in
   * the unsafe direction, and no test would have to change for it to happen.
   *
   * **A REFUSAL KEEPS THE PROPOSAL, and it costs no code to do it**: every
   * refusal here is thrown from inside the transaction, so the delete that
   * would have consumed the row is rolled back with everything else. A person
   * whose post was approved underneath them, or whose selection now absorbs a
   * sentence of their own, can reject the approval or re-select and use the
   * call they already bought. `refine_proposal_not_found` is the one refusal
   * that means the row really is gone.
   *
   * **`created_by` IS NULL** on the version row, unlike every human one: the
   * model wrote that text. The person who asked for it is on the proposal row,
   * which is where a request belongs, and `content_versions.created_by`'s own
   * comment already says "Null for AI-written versions" — this is its second
   * writer.
   *
   * Answers the ITEM, like every other mutation on this resource, so the screen
   * that pressed Accept redraws from one response: the merged body, the badge
   * recomputed over the new fragment row, and `refineProposal` back to `null`.
   */
  async acceptRefine(orgId: string, id: string, proposalId: string) {
    await db.transaction(async (tx) => {
      // The item first — and this order is one of REFUSALS, not of locks.
      // `lockedProposal` takes no lock of its own (its own docstring says why),
      // so swapping these two statements would move nothing in the lock order:
      // the first lock either way is this `FOR UPDATE`. What it does decide is
      // what a person is told when a post an approval has pinned is accepted
      // with a proposal id that is already gone, and the answer is the pinned
      // 409 rather than the 404. It is the fact that governs everything they
      // can do with this post, it tells them the act that changes it (reject
      // the approval), and it is the SAME sentence they get when the proposal
      // is still staged — one story about a pinned post, not two depending on
      // whether the card they are looking at survived.
      const item = await this.requireEditableItem(tx, orgId, id);
      const proposal = await this.lockedProposal(tx, orgId, id, proposalId);

      // THE BODY IN ITS CANONICAL FORM, and the same string throughout: the
      // anchor is found in it, the offsets index it, the merge is spliced into
      // it and the guard reasons about it. `planRefineAccept` requires this and
      // says so — it normalises the merged body while `start`/`end` stay where
      // they were measured — and `content_items.body` is only canonical for
      // bodies written through the DTO. The worker's is not: `editor.ts` and
      // `writer.ts` bound the model's reply's length and nothing else, and the
      // terminal write inserts it verbatim, so a draft carrying a CR is a real
      // row rather than a hypothesis. Measured on that shape: every offset
      // after the CR is one too large in the merged string, and the fragment
      // row comes out holding a sentence the splice never touched — the
      // product's evidence that a model wrote a unit, filed off a string it did
      // not write.
      //
      // `proposal.start` was measured against the body BEFORE this, and stays
      // as it is: it is not a splice point, only what "nearest" is measured
      // from, and a handful of characters of drift cannot pick a different
      // occurrence of the same sentence. The splice point is the occurrence
      // itself, found in this string.
      const body = normalizeNewlines(item.body);
      const start = nearestOccurrence(body, proposal.selectedText, proposal.start);
      if (start === null) {
        throw conflict(
          "refine_anchor_lost",
          "The text this suggestion was written for is no longer in this post",
        );
      }

      const aiRows = await tx
        .select({ body: schema.contentVersions.body })
        .from(schema.contentVersions)
        .where(
          and(
            eq(schema.contentVersions.orgId, orgId),
            eq(schema.contentVersions.contentItemId, id),
            isNull(schema.contentVersions.adaptationId),
            eq(schema.contentVersions.origin, "ai"),
          ),
        );

      const plan = planRefineAccept({
        body,
        start,
        // The range is derived from the RE-LOCATED anchor, never from the
        // stored offsets: those describe where the selection was when the model
        // was asked, and the body may have moved under it since.
        end: start + proposal.selectedText.length,
        proposal: proposal.proposal,
        aiRows,
      });
      if (!plan.ok) {
        const refusal = REFINE_PLAN_REFUSAL[plan.reason];
        throw conflict(refusal.code, refusal.message);
      }

      if (!("unchanged" in plan)) {
        await tx
          .update(schema.contentItems)
          // The `org_id` predicate is defence in depth and CANNOT be pinned by a
          // test, unlike the identical-looking one on the proposal read: an item
          // belongs to exactly one organisation, so `requireEditableItem` has
          // already refused every other org's item and there is no row a planted
          // fixture could reach here. The proposal read's predicate is pinnable
          // precisely because a `refine_proposals` row can carry one org's id
          // while pointing at another's draft (`otherOrgProposalRow`), and this
          // asymmetry is the reason a mutation dropping this line SURVIVES.
          .set({ body: plan.mergedBody })
          .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)));
        await tx.insert(schema.contentVersions).values({
          orgId,
          contentItemId: id,
          adaptationId: null,
          // The MERGED body's own units, not the model's reply as it arrived: a
          // proposal without a terminator fuses with its neighbour, and a row
          // holding the raw reply would leave the fused unit in no version row
          // at all — which reads as a human's sentence.
          body: plan.fragmentBody,
          origin: "ai",
          scope: "fragment",
          // Authored ONCE, here, and never recomputed from the fragment's text
          // at read time: the whole point of storing the difference is that the
          // gate adds up numbers rather than re-splitting bodies.
          unitDelta: plan.unitDelta,
          createdBy: null,
        });
      }

      await tx.delete(schema.refineProposals).where(eq(schema.refineProposals.id, proposal.id));
    });
    return this.get(orgId, id);
  }

  /**
   * The proposal this Accept is about, read under the item's lock.
   *
   * THREE PREDICATES, and the middle one is the load-bearing one. `org_id`
   * keeps a stranger out; `id` is what the caller named; and
   * `content_item_id` is what stops a proposal of ANOTHER draft of the same
   * org from being applied here — its anchor and its offsets were measured
   * against a different body, so accepting it would splice the model's words
   * into a post nobody asked it about and file a version row saying a model
   * wrote them.
   *
   * A plain `SELECT` with no lock of its own, and that is exact rather than
   * lazy: every transaction that writes this row takes `content_items` first
   * (`docs/lock-order.md`), and this one holds it `FOR UPDATE` — so no
   * concurrent press can supersede the row between this read and the delete
   * below. A `FOR UPDATE` here would order nothing that is not already ordered.
   *
   * 404 with its own code rather than `content_not_found`: the post is right
   * there in front of the reader; it is the suggestion that is gone.
   */
  private async lockedProposal(
    tx: Tx,
    orgId: string,
    contentItemId: string,
    proposalId: string,
  ): Promise<RefineProposal> {
    const rows = await tx
      .select(PROPOSAL_COLUMNS)
      .from(schema.refineProposals)
      .where(
        and(
          eq(schema.refineProposals.orgId, orgId),
          eq(schema.refineProposals.contentItemId, contentItemId),
          eq(schema.refineProposals.id, proposalId),
        ),
      )
      .limit(1);
    const proposal = rows[0];
    if (!proposal) {
      throw notFound(
        "refine_proposal_not_found",
        "That suggestion is no longer staged for this post",
      );
    }
    return proposal;
  }

  /**
   * THROW THE SUGGESTION AWAY. 204, because there is nothing to say back.
   *
   * NO EDITABILITY CHECK, and that is a decision rather than an omission: a
   * discard changes no text, and refusing it on an approved post would leave a
   * card on the screen whose Accept is refused and which nothing can clear.
   *
   * ONE STATEMENT, no transaction and no lock beyond the row's own: this takes
   * `refine_proposals` and nothing else, so it holds nothing anybody could
   * queue behind. Deleting a child row takes no lock on its parent, so it
   * cannot arrive at `content_items` out of order — the reason it is safe to
   * be the one transaction here that does not take the item first.
   *
   * 404 when the row is already gone — accepted, discarded, superseded, or
   * another org's — which is the same code and the same sentence in each case,
   * because they are the same fact about this request: there is no such
   * suggestion to discard. A browser treats it as success, which is the honest
   * reading of "the thing you asked to be rid of is not there".
   */
  async discardRefine(orgId: string, id: string, proposalId: string): Promise<void> {
    const deleted = await db
      .delete(schema.refineProposals)
      .where(
        and(
          eq(schema.refineProposals.orgId, orgId),
          eq(schema.refineProposals.contentItemId, id),
          eq(schema.refineProposals.id, proposalId),
        ),
      )
      .returning({ id: schema.refineProposals.id });
    if (deleted.length === 0) {
      throw notFound(
        "refine_proposal_not_found",
        "That suggestion is no longer staged for this post",
      );
    }
  }

  /**
   * Same pin as `update`, one level down: an approved item's per-channel
   * override is the exact text that channel will receive, so it is frozen for
   * as long as a delivery is outstanding.
   *
   * Both conditions are checked, not just the item's: the two can disagree
   * after a partial fan-out, where one channel published and the item is still
   * `approved`.
   *
   * A changed override leaves a version row of its own, at the ADAPTATION's
   * level — the same rule as `update`, one level down, and the level matters:
   * filing one channel's text as the master body's would make a history that
   * restores the wrong text into the wrong place. The authorship-per-sentence spec's §6 says so explicitly
   * because the design's earlier draft was silent about this method.
   */
  async updateAdaptation(
    orgId: string,
    contentItemId: string,
    adaptationId: string,
    data: AdaptationUpdate,
    userId: string,
  ) {
    return db.transaction(async (tx) => {
      // `adaptations` before `content_items` — the product's one lock order,
      // written down in `docs/lock-order.md`, which this file is the fourth
      // site of. `body` comes back for
      // the same reason `requireEditableItem` returns the item's: it is the
      // text this save is compared against, read under the lock that makes the
      // comparison hold until the write lands.
      const locked = await tx
        .select({ status: schema.adaptations.status, body: schema.adaptations.body })
        .from(schema.adaptations)
        .where(
          and(
            eq(schema.adaptations.orgId, orgId),
            eq(schema.adaptations.contentItemId, contentItemId),
            eq(schema.adaptations.id, adaptationId),
          ),
        )
        // Belt and braces, and a mutation that drops it is an equivalent one:
        // the predicate above names the primary key, so this matches at most
        // one row whatever the limit says.
        .limit(1)
        .for("update");
      const current = locked[0];
      if (!current) throw notFound("adaptation_not_found", "Adaptation not found");

      await this.requireEditableItem(tx, orgId, contentItemId);
      if (!isEditableAdaptationStatus(current.status)) {
        throw conflict(
          PINNED_ADAPTATION_CODE[current.status],
          PINNED_ADAPTATION_MESSAGE[current.status],
        );
      }

      const rows = await tx
        .update(schema.adaptations)
        .set({ body: data.body })
        .where(
          and(
            eq(schema.adaptations.orgId, orgId),
            eq(schema.adaptations.contentItemId, contentItemId),
            eq(schema.adaptations.id, adaptationId),
          ),
        )
        .returning(ADAPTATION_COLUMNS);
      const updated = rows[0];
      if (!updated) throw notFound("adaptation_not_found", "Adaptation not found");

      const versionBody = humanVersionBody(current.body, data.body);
      if (versionBody !== null) {
        await this.recordHumanVersion(tx, {
          orgId,
          contentItemId,
          adaptationId,
          body: versionBody,
          createdBy: userId,
        });
      }
      return updated;
    });
  }

  /**
   * 404s an item that does not exist in this org, WITHOUT taking a row lock on
   * it — the lock on `content_items` must not be acquired before the one on
   * `adaptations` (see `lockAdaptations`), and this check runs BEFORE them. A
   * concurrent delete between this check and the later status write is
   * harmless: the write matches no rows and the reread at the end of the call
   * 404s anyway.
   *
   * That is what separates this from `requireNotPublished`, which asks about
   * the same row a few lines later and DOES lock it: the difference is not the
   * question, it is which side of `lockAdaptations` the read falls on. Merging
   * the two into one locked read would put `content_items` first and invert the
   * order for real.
   */
  private async requireItem(tx: Tx, orgId: string, id: string): Promise<void> {
    const rows = await tx
      .select({ id: schema.contentItems.id })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .limit(1);
    if (rows.length === 0) throw notFound("content_not_found", "Content item not found");
  }

  /**
   * Refuses to approve an item that has NO adaptations at all.
   *
   * Without this, `approve` returned 200 and stored `approved` while enqueueing
   * nothing whatsoever: a post that reads sent on every screen and was never
   * sent anywhere, with no failure, no `publications` row and no job to explain
   * it. The generation path already refuses exactly this shape and says why —
   * losing every channel mid-run is a terminal `every_channel_deleted` rather
   * than an item with zero adaptations, because "`approve` would happily mark
   * approved while enqueueing nothing at all" (generate.service.ts). The api
   * cannot produce the shape on creation (`contentCreateSchema` requires at
   * least one channel), but deleting a channel cascades its adaptations away,
   * so an item that had channels yesterday can have none today.
   *
   * A 409 rather than a 400: the request is well formed and it was valid until
   * the channels went away. The message says what happened rather than offering
   * a recovery, because there is none to offer — nothing adds an adaptation to
   * an existing item; the content has to be created again for the new channel.
   *
   * An unlocked read, and it does not need to be one: this asks whether the
   * item has any channels at all, and a channel deleted a moment after the
   * check leaves a queued job whose delivery fails on its own terms. It is the
   * "nothing at all" case that has no failure path to fall back on.
   */
  private async requireAdaptations(tx: Tx, orgId: string, id: string): Promise<void> {
    const rows = await tx
      .select({ id: schema.adaptations.id })
      .from(schema.adaptations)
      .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.contentItemId, id)))
      .limit(1);
    if (rows.length === 0) {
      throw conflict(
        "content_no_channels_left",
        "This content has no channels left to publish to; every channel it was written for has " +
          "been deleted",
      );
    }
  }

  /**
   * Refuses a NEW SCHEDULE that cannot reach every one of the item's channels.
   *
   * `approve` re-targets `pending`, `failed` and `scheduled` deliveries and
   * leaves `queued` and `publishing` alone, for reasons its own comment gives
   * and which are not in question here: a queued send is on its way with no
   * delay left to change, and re-enqueueing either would cancel a live job — for
   * `publishing`, an entire transient-retry chain that may still succeed.
   *
   * WHAT WAS WRONG WAS THE ANSWER, NOT THE BEHAVIOUR. Setting a new time on an
   * item whose channels were all queued matched nothing, enqueued nothing,
   * wrote `scheduled_at` nowhere — and returned 200. The screen re-read the
   * item, painted the delivery it was given, and the post went out at the old
   * time. That is this project's named class: an early exit that reports the
   * same success as real work (`requireAdaptations` above is the same class
   * from the other end, and `reject`'s 409 on a published item is the same
   * again).
   *
   * IT REFUSES RATHER THAN MOVING WHAT IT CAN. A partial answer — "two channels
   * took the new time, one is already gone" — is a post going out at two
   * different times from one decision, which nobody asked for and which the
   * reader would have to notice rather than be told. Refusing changes nothing,
   * costs nothing, and leaves one recovery to describe instead of a state to
   * explain.
   *
   * ONLY A SCHEDULE. "Publish now" over the same rows still answers 200, and
   * truthfully: the caller is asking for the post to be on its way, and a
   * queued or publishing channel already is. There is no belief to correct, so
   * there is nothing to refuse — and the existing behaviour that re-approving
   * enqueues nothing for those rows is exactly right.
   *
   * `publishing` WINS OVER `queued` when both are present, because it is the
   * sharper fact: one is committed and the other may already be live, and the
   * sentence a reader needs is the one about the delivery that cannot be taken
   * back.
   *
   * AN UNLOCKED READ, deliberately. `approve` does not lock `queued` or
   * `publishing` rows — that is the whole of why it does not wait on the worker
   * — and locking them here to decide a refusal would hand it the deadlock
   * exposure the target set was chosen to avoid. The status it reads can change
   * a moment later, and in the only direction that matters: an attempt that
   * lands turns the row `published` or `failed`, and the caller's retry then
   * succeeds. A refusal that a retry clears is the fail-safe direction; a 200
   * that changed nothing is not.
   */
  private async requireScheduleReachesEveryChannel(
    tx: Tx,
    orgId: string,
    id: string,
  ): Promise<void> {
    const committed = await tx
      .select({ status: schema.adaptations.status })
      .from(schema.adaptations)
      .where(
        and(
          eq(schema.adaptations.orgId, orgId),
          eq(schema.adaptations.contentItemId, id),
          inArray(schema.adaptations.status, UNSCHEDULABLE_STATUSES),
        ),
      );
    if (committed.length === 0) return;
    if (committed.some((adaptation) => adaptation.status === "publishing")) {
      throw conflict(
        "schedule_already_publishing",
        "This post is being sent to one of its channels right now, so it cannot be moved to a " +
          "new time; wait for that delivery to finish and decide from what it reports",
      );
    }
    throw conflict(
      "schedule_already_queued",
      "This post is already queued for publishing, so it cannot be moved to a new time; reject " +
        "it to stop the delivery, then approve it again with the time you want",
    );
  }

  /**
   * Refuses to re-decide an item that has already gone out.
   *
   * Existence was never the only precondition: `setItemStatus` writes
   * unconditionally, so approving or rejecting a fully published item returned
   * 200 and stored `approved`/`rejected` over `published` — a permanent lie
   * about a post that is live in someone's channel, with nothing to repair it
   * (`recomputeItemStatus` only ever runs from the worker, and the worker is
   * long done by then).
   *
   * Read AFTER the caller has locked the adaptations, and that is the whole
   * point of it being a separate step from `requireItem`: the worker's
   * `markPublished` locks the adaptations and only then promotes the item, so a
   * status read taken before the lock can still say `approved` about a publish
   * that commits a moment later.
   *
   * **`FOR UPDATE`, because the adaptation locks do not cover `approve`.** The
   * worker's `markPublished` always runs against a `publishing` adaptation.
   * `reject` targets that status and therefore waits on the worker's row lock
   * before it ever gets here; `approve` deliberately does NOT (see its own
   * comment), so its `lockAdaptations` touches nothing the worker holds and it
   * arrives at this line with no synchronisation at all. With an unlocked read
   * it then saw the COMMITTED `approved` while the worker's promotion sat
   * uncommitted a statement away, passed, and queued its own write behind the
   * worker's row lock — landing `approved` ON TOP of `published`. Measured, not
   * theorised: 200 returned, the item stored as `approved` beside a `published`
   * adaptation and a live post — and an item stored that way can then be
   * REJECTED, which is how a published item comes to read `rejected` next to a
   * post nobody can take back. Under the lock this transaction either waits for
   * the worker and reads `published` (409), or gets there first and the
   * worker's promotion lands afterwards on a status it has already decided.
   *
   * An earlier version of this comment justified the unlocked read by claiming
   * a `FOR UPDATE` here "would invert the lock order the whole codebase depends
   * on". **It would not, and that wrong reason is how the bug comes back.**
   * Both callers have ALREADY taken the adaptation locks by the time they reach
   * this line (`lockAdaptations`, the step this one is deliberately separate
   * from), so locking `content_items` after them is precisely the documented
   * order — `adaptations`, then `content_items` — that the worker's
   * `markPublished`/`markFailed` also follow. The lock this call takes is then
   * held for the rest of the transaction, which is what also makes the gate
   * below it (`requireHumanInvolvement`) read a body nobody can replace before
   * the status write lands.
   */
  private async requireNotPublished(tx: Tx, orgId: string, id: string): Promise<void> {
    const rows = await tx
      .select({ status: schema.contentItems.status })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .limit(1)
      .for("update");
    if (rows[0]?.status === "published") {
      throw conflict(
        "content_already_published",
        "This content has already been published; it can no longer be approved or rejected",
      );
    }
  }

  /**
   * The publish rule: approval is refused when NO HUMAN HAS OPENED THE ITEM AND
   * NOTHING HAS BEEN TOUCHED.
   *
   * Three clauses, all of which must hold for the refusal — any one of them
   * being false is a human in the loop, and approval proceeds:
   *
   * 1. THE MODEL WROTE SOMETHING HERE: the item's `origin` is `ai`, OR an `ai`
   *    version row exists at ANY level of it — the item's own body or any
   *    adaptation's. A wholly human item is nobody's business here, and this
   *    clause is what keeps it out: it has no `ai` rows at all, so every "is
   *    this still the AI's text?" question below would answer "cannot prove
   *    otherwise" and lock the product's ordinary flow.
   *    The adaptation half is the authorship-per-sentence spec's §5, closing the limit this comment used to
   *    record: entering on the ITEM's origin alone let a human-written item
   *    carrying AI-WRITTEN ADAPTATIONS skip every check below and ship its
   *    channel text unread. Nothing produced that shape when the gate was
   *    written (the terminal write marks the item `ai` too); increment 2b-2's
   *    refine verbs on a hand-typed draft produce it immediately.
   *    The origin half is NOT redundant with the row half, and dropping it
   *    would be a hole rather than a simplification: an `ai` item whose version
   *    rows a worker bug never wrote has no rows to find, and "no evidence"
   *    must refuse, not walk out of the gate (see "missing evidence" below).
   *    `adaptations.origin` is deliberately NOT a third disjunct — it defaults
   *    to `human`, so it can only fail to enter, but the version row is the
   *    evidence this rule is actually made of and the column is not.
   *    The cost, paid knowingly: a draft whose body a human typed themselves is
   *    refused until they open it, and for that shape ONLY opening it helps —
   *    see `UNREAD_AI_DRAFT_OPEN_ONLY_MESSAGE`, which says so.
   * 2. `first_opened_at IS NULL` — nobody has opened it (`markOpened`).
   * 3. EVERY SENTENCE of the text is still the model's, AT BOTH LEVELS. The
   *    item body against the item's own `ai` rows, and EVERY adaptation against
   *    its own — because `adaptations.body ?? contentItems.body` is what the
   *    worker actually sends (publish.service.ts), so a rule that checked only
   *    the master text would pass an item whose every channel still ships
   *    untouched AI.
   *
   * Clause 3 used to be a whole-body equality against the FIRST `ai` row per
   * level, and increment 2b's refine verbs break that: an accepted proposal
   * merges a fragment into the body, the body then equals no stored row, and
   * equality reads a human touch that never happened — the gate publishing a
   * draft nobody opened, to exactly the callers it was written for. The
   * question is therefore asked one sentence at a time (`allSentencesAi`,
   * authorship-per-sentence spec §2), which needs TWO things per level rather than one row:
   *
   * - EVERY `ai` body, for the mask. A sentence still counts as the model's
   *   when ANY `ai` row wrote it, so an accepted proposal's fragment covers the
   *   sentence it replaced. The rows are NOT concatenated — see
   *   `aiSentenceMaskAny`, which keeps each version's own multiset count.
   * - The first `scope = 'full'` row as the deletion clause's anchor, PLUS
   *   every fragment row's `unit_delta`. A mask has no notion of count, so a
   *   body that is a strict subset of the model's sentences would read "all AI"
   *   and a caller who TRIMMED the draft would be refused with a message
   *   telling them to edit it. A fragment cannot be that anchor: it is shorter
   *   than the body it edits by construction, so counting its sentences as the
   *   body's would read every refine as a deletion. It MOVES the anchor
   *   instead, by the signed unit count it recorded at Accept — which is what
   *   stops a successful *shorten* from reading as a deletion nobody made.
   *
   * That is literally the same call the badge makes (`get`, `list`) and the
   * fine grain of what the lens paints, off the same rows — one question, two
   * references, instead of three formulas that could disagree on one screen.
   * Never string equality either way:
   * the comparison normalises whitespace and Unicode composition, so a stray
   * space or an NFD paste is not a human touch.
   *
   * Missing evidence refuses, and PARTIAL evidence refuses with it. An `ai`
   * item with no version row to compare against reads as untouched, an
   * adaptation with no version row of its own does too, and so does a level
   * whose only `ai` rows are fragments — with no `full` row a deletion and a
   * rewrite are indistinguishable. The promise is about what we can PROVE a
   * human touched, and the recovery is one click (open it) rather than a
   * published draft nobody read. That direction matters because
   * `adaptations.origin` defaults to `human` — deriving "touched" from the
   * origin column instead would turn a worker that forgot to set it into an
   * open publish gate.
   *
   * **`FOR UPDATE`, because the verdict is about the text that will actually
   * go out.** This used to be a plain read, excused with the same wrong reason
   * `requireNotPublished` records: locking `content_items` here does not invert
   * any order, since `lockAdaptations` has already run and this is the second
   * half of the pair. What the unlocked read did allow was an edit landing
   * UNDERNEATH an approval — the editor's transaction holds the item's lock
   * (`requireEditableItem`), this gate reads the committed OLD body and passes
   * it, the loop enqueues, and only then does `setItemStatus` queue behind that
   * lock: the editor commits its replacement, approve commits `approved` on top
   * of it, and the channel receives text the gate never saw. Measured with a
   * revert to the model's verbatim draft: 200, the item queued for delivery
   * carrying an unopened, untouched AI body — the exact shape this method
   * exists to refuse.
   *
   * The lock is already held by `requireNotPublished` a line earlier, so this is
   * a re-lock of a row this transaction owns and costs nothing — and, said
   * plainly because a mutation test was run rather than reasoned about:
   * deleting THIS `.for("update")` alone fails no test, while deleting both
   * fails "409s an approve whose gate would otherwise judge a body the editor
   * is replacing". It is kept because the redundancy is the point: this method
   * decides what text ships, and it should not depend on a caller continuing to
   * lock the row for it two refactors from now.
   */
  private async requireHumanInvolvement(tx: Tx, orgId: string, id: string): Promise<void> {
    const rows = await tx
      .select({
        body: schema.contentItems.body,
        origin: schema.contentItems.origin,
        firstOpenedAt: schema.contentItems.firstOpenedAt,
      })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .limit(1)
      .for("update");
    const item = rows[0];
    // `requireItem` already 404'd a missing row; a delete racing this read is
    // harmless (the writes below it match nothing).
    if (!item) return;

    // The `ai` version rows are the provenance evidence. Filtered on origin
    // because increment 2 appends human versions to the same table — a version
    // the author typed is not evidence that the model wrote a sentence — and
    // ordered so "first" cannot drift: the worker writes item and adaptation
    // versions in one transaction, where `now()` — and therefore `created_at` —
    // is identical for all of them, so `created_at` alone is not a total order.
    // `unit_delta` travels with `scope`, for the reason `AI_VERSION_COLUMNS`
    // spells out: without it a refine that SHORTENED the draft is a deletion
    // this gate cannot tell from a human's, and it opens on an unread draft.
    const versions = await tx
      .select({
        adaptationId: schema.contentVersions.adaptationId,
        body: schema.contentVersions.body,
        scope: schema.contentVersions.scope,
        unitDelta: schema.contentVersions.unitDelta,
      })
      .from(schema.contentVersions)
      .where(
        and(
          eq(schema.contentVersions.orgId, orgId),
          eq(schema.contentVersions.contentItemId, id),
          eq(schema.contentVersions.origin, "ai"),
        ),
      )
      .orderBy(asc(schema.contentVersions.createdAt), asc(schema.contentVersions.id));

    // Clause 1, and the reason this query moved ABOVE the bail-out: the rows
    // that answer "did the model write any of this" are the same rows the
    // checks are made of, so the gate asks for them once. `contentItemId` is
    // set on an adaptation's version rows too, so this one list is "the item or
    // any of its adaptations" — no second query, and no chance of the entry and
    // the evidence disagreeing about which rows exist.
    if (item.origin !== "ai" && versions.length === 0) return;

    /**
     * Every `ai` body per level for the mask, and each level's first `full` row
     * for the deletion clause — the same collector the badge reads through, so
     * the gate and the badge cannot come to disagree about which row is first.
     */
    const aiEvidence = collectAiEvidence(versions, (version) => version.adaptationId);

    const adaptations = await tx
      .select({ id: schema.adaptations.id, body: schema.adaptations.body })
      .from(schema.adaptations)
      .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.contentItemId, id)));

    /**
     * Is every sentence of `current` still the model's, judged against one
     * LEVEL's evidence — `null` for the master body, an adaptation id for a
     * channel's own text.
     *
     * Takes the level rather than the reference strings so the cleared-override
     * branch below can switch both of them together and cannot switch one
     * without the other. Untouched unless we can prove otherwise:
     * `allSentencesAi` answers true for a level with no rows and for one with
     * no `full` row — see "missing evidence" above.
     */
    const stillAi = (current: string, level: string | null): boolean => {
      const evidence = aiEvidence.get(level) ?? NO_AI_EVIDENCE;
      return allSentencesAi(current, evidence.rows, evidence.firstFullBody);
    };

    const nobodyOpened = item.firstOpenedAt === null;
    const bodyIsAi = stillAi(item.body, null);
    const everyChannelIsAi = adaptations.every((adaptation) =>
      // The channel's text AND the version it is judged against, together.
      // `adaptations.body ?? content_items.body` is the worker's own fallback,
      // so a cleared override means this channel ships the ITEM's text — and it
      // must then be compared with the ITEM's AI version. Giving the shipped
      // text the fallback but not the reference compared the master body
      // against the ADAPTATION's AI version, which the adapter rewrote for the
      // platform and so never matches: clearing an override read as a human
      // edit and published every channel's verbatim AI text. The shipped web UI
      // sends exactly that null (content/[id]/page.tsx, an emptied textarea).
      adaptation.body === null ? stillAi(item.body, null) : stillAi(adaptation.body, adaptation.id),
    );

    if (nobodyOpened && bodyIsAi && everyChannelIsAi) {
      // Which refusal is the true one is decided by ONE fact: whether the body
      // has a complete `ai` version to be judged against. With one, an edit is
      // a real recovery — a sentence of the author's own, or a deletion, and
      // `bodyIsAi` turns false. Without one, `allSentencesAi` short-circuits on
      // missing evidence and no body a caller could type would ever answer
      // differently, so telling them to edit it is telling them to do something
      // that cannot work. Read off the collected evidence rather than off
      // `item.origin`, because the shapes that cannot be edited out are not
      // only the hand-typed one: an `ai` item whose version rows are missing
      // altogether, or whose only `ai` row is a refine `fragment`, are the same
      // dead end and get the same sentence.
      const bodyEvidence = aiEvidence.get(null) ?? NO_AI_EVIDENCE;
      throw bodyEvidence.firstFullBody === undefined
        ? conflict("unread_ai_draft_open_only", UNREAD_AI_DRAFT_OPEN_ONLY_MESSAGE)
        : conflict("unread_ai_draft", UNREAD_AI_DRAFT_MESSAGE);
    }
  }

  /**
   * Records that a human has opened this item, once.
   *
   * Its own endpoint rather than a side effect of the GET, and that is the
   * whole design: the public API and the MCP server will issue GETs with no
   * human anywhere near them, and a GET that stamped the read receipt would
   * hand them the ability to open the publish gate by listing content. The web
   * app fires this from the item page after render.
   *
   * `WHERE first_opened_at IS NULL` keeps the FIRST open: the column answers
   * "has anyone ever read this", so overwriting it on every visit would lose
   * the only timestamp anyone would want, and makes concurrent opens a no-op
   * for the loser rather than a lost update.
   *
   * Idempotent: a second call is 204 too. Zero rows updated is ambiguous —
   * already stamped, or not this org's item — so it is disambiguated with one
   * read, because an org must not be able to stamp another org's draft (or
   * learn that it exists).
   */
  async markOpened(orgId: string, id: string): Promise<void> {
    const stamped = await db
      .update(schema.contentItems)
      // A JS Date, matching `scheduledAt`: the column is `timestamptz`, so the
      // instant this process means is the instant Postgres stores whatever
      // zone either of them is running in. It used to be zoneless, and this
      // comment used to explain that drizzle's UTC-on-both-sides convention
      // made the round trip come out right — true, and true only of readers
      // that go through drizzle. Migration 0014 made it a property of the
      // column instead of a property of the client.
      .set({ firstOpenedAt: new Date() })
      .where(
        and(
          eq(schema.contentItems.orgId, orgId),
          eq(schema.contentItems.id, id),
          isNull(schema.contentItems.firstOpenedAt),
        ),
      )
      .returning({ id: schema.contentItems.id });
    if (stamped.length > 0) return;

    const existing = await db
      .select({ id: schema.contentItems.id })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .limit(1);
    if (existing.length === 0) throw notFound("content_not_found", "Content item not found");
  }

  private async setItemStatus(
    tx: Tx,
    orgId: string,
    id: string,
    status: ContentStatus,
  ): Promise<void> {
    await tx
      .update(schema.contentItems)
      .set({ status })
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)));
  }

  /**
   * Locks the adaptations of one item that are in `statuses`, inside the
   * caller's transaction.
   *
   * `FOR UPDATE` is load-bearing, not decoration: the worker claims an
   * adaptation with an UPDATE (`markPublishing`), which takes the same row
   * lock. Locking here serialises "is this still deliverable?" against "I am
   * delivering it now" instead of letting both read a stale row — either we
   * see the worker's write, or the worker's claim waits for this transaction
   * and then finds a status it must not publish from (see the worker's
   * `markPublishing`).
   *
   * Callers must take this lock BEFORE LOCKING OR writing `content_items`. The
   * worker's `markPublished`/`markFailed` lock adaptations first and only then
   * the parent item (`recomputeItemStatus`), so taking the item first here
   * would give the two sides opposite lock orders — a genuine deadlock whenever
   * a publish finishes at the same moment as an approve or reject.
   *
   * "Before", not "instead of": everything the caller does to `content_items`
   * AFTER this — `requireNotPublished`'s `FOR UPDATE`, the gate's read, the
   * status write — is in the documented order and belongs under a lock. It was
   * the reading of `content_items` WITHOUT one, excused as protecting this
   * order, that let an approve overwrite a `published` item and let an edit
   * land underneath an approval.
   *
   * "Writing `content_items`" includes writing anything that REFERENCES an
   * adaptation: a `content_versions` insert takes `FOR KEY SHARE` on both FK
   * targets, so filing an adaptation-level version row from a transaction
   * holding only the item's lock inverts this order exactly as an UPDATE
   * would. See `recordHumanVersion`, which states that invariant in full.
   *
   * `ORDER BY id` for the same reason one level down. Without it Postgres is
   * free to return an item's adaptations in any order, so two concurrent
   * approves of the same multi-channel item can lock its rows in opposite
   * orders and deadlock each other — a 500 on a request that is merely
   * duplicated, not wrong. A deterministic order makes the second approve wait
   * instead.
   */
  private lockAdaptations(
    tx: Tx,
    orgId: string,
    contentItemId: string,
    statuses: AdaptationStatus[],
  ) {
    return tx
      .select({
        id: schema.adaptations.id,
        channelId: schema.adaptations.channelId,
        status: schema.adaptations.status,
        attemptCount: schema.adaptations.attemptCount,
      })
      .from(schema.adaptations)
      .where(
        and(
          eq(schema.adaptations.orgId, orgId),
          eq(schema.adaptations.contentItemId, contentItemId),
          inArray(schema.adaptations.status, statuses),
        ),
      )
      .orderBy(schema.adaptations.id)
      .for("update");
  }

  /**
   * Approves an item and enqueues (or re-enqueues) its outstanding adaptations.
   *
   * `scheduled` is in the target set, not just `pending`/`failed`: without it
   * "Publish now" on an already-scheduled item returned 200, flipped the item
   * to `approved` and enqueued nothing, while the post still fired at the OLD
   * time — the UI reported a change that never happened. A scheduled
   * adaptation is genuinely rescheduled here: its outstanding job is cancelled
   * and a fresh one is enqueued with the new `startAfter`.
   *
   * `queued` and `publishing` are deliberately NOT targets. A queued
   * adaptation is already on its way out with no delay to change, and a
   * `publishing` one is mid-attempt: re-enqueueing either would cancel a live
   * job — for `publishing`, an entire transient-retry chain that may still
   * succeed on its own — for no user-visible gain. An in-flight attempt
   * records its own truth when it lands (`markPublished` writes
   * unconditionally; `markFailed` is now fenced on the status and attempt
   * count it was dispatched for, so a dead attempt can no longer overwrite a
   * row this path has since re-approved), and a `failed` outcome is
   * re-approvable.
   * (Rejecting DOES act on both — there the point is to stop the delivery, not
   * to move it.)
   *
   * Skipping them is not the same as being silent about them. A request that
   * names a NEW TIME and meets one of those rows is refused
   * (`requireScheduleReachesEveryChannel`), because the post would otherwise go
   * out at the old time behind a 200. A request with no time is not: "publish
   * now" is already true of a queued or publishing channel.
   *
   * An item that has ALREADY published every one of its adaptations is refused
   * with a 409 (`requireNotPublished`): there is nothing left to enqueue, and
   * the only lasting effect used to be overwriting `published` with `approved`.
   *
   * An item with NO adaptations left at all is refused too
   * (`requireAdaptations`) — same reason from the other end: approving it
   * enqueued nothing and reported success for a post that was never sent.
   *
   * And an AI draft that no human has opened or touched is refused too
   * (`requireHumanInvolvement`) — the promise, enforced here rather than in the
   * UI, because this is the only door to `enqueuePublish`.
   */
  async approve(orgId: string, id: string, scheduledAt: Date | null) {
    // A SCHEDULE IN THE PAST, refused here rather than by `contentApproveSchema`.
    //
    // It used to be a zod `.refine` on the DTO, and being there is what made the
    // reader's error read "scheduledAt: scheduledAt must be in the future" — the
    // pipe's `path: message` join wrapped around a message that names the field
    // a second time. It could not be given a code where it stood, because the
    // pipe refuses a whole body and cannot say which of its issues mattered.
    //
    // It is not validation, either. Validation asks about the SHAPE of a
    // request, and a shape does not stop being valid while you look at it: this
    // predicate reads the clock, so a body that parsed a moment ago is false
    // now. A DTO whose verdict changes between parse and use is a domain rule
    // wearing a schema's clothes, and this is where domain rules live.
    //
    // Before the transaction on purpose — it needs no row and no lock, and a
    // refusal should cost neither. pg-boss treats a past `startAfter` as "run
    // now", so without this a typo'd or stale date publishes IMMEDIATELY
    // instead of being scheduled, which is the damage the rule exists to stop.
    if (scheduledAt !== null && scheduledAt.getTime() <= Date.now()) {
      throw badRequest("schedule_in_past", "scheduledAt must be in the future");
    }
    await db.transaction(async (tx) => {
      await this.requireItem(tx, orgId, id);
      const targets = await this.lockAdaptations(tx, orgId, id, ["pending", "failed", "scheduled"]);
      await this.requireNotPublished(tx, orgId, id);
      // After `requireNotPublished` too: an item whose channels are gone AND
      // which already published from them is a published item first.
      await this.requireAdaptations(tx, orgId, id);
      // Only for a request that names a time: "Publish now" over a queued or
      // publishing channel is already true of it. See the method's own comment.
      if (scheduledAt !== null) {
        await this.requireScheduleReachesEveryChannel(tx, orgId, id);
      }
      // After `requireNotPublished`: an item already live in a channel gets the
      // message about the post that went out, not one about reading it. Before
      // the loop, so a refusal costs no queue work.
      await this.requireHumanInvolvement(tx, orgId, id);

      for (const adaptation of targets) {
        // CURRENT attempt count (before this attempt) — see publishJobId's contract.
        let attemptCount = adaptation.attemptCount;
        if (adaptation.status === "scheduled") {
          // The cancelled job keeps its id, so the count must advance or the
          // re-enqueue would be swallowed by send()'s ON CONFLICT DO NOTHING.
          await this.queue.cancelPublish(tx, adaptation.id, orgId);
          attemptCount += 1;
        }
        await tx
          .update(schema.adaptations)
          .set({
            status: scheduledAt ? "scheduled" : "queued",
            scheduledAt,
            lastError: null,
            attemptCount,
          })
          .where(
            and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptation.id)),
          );
        await this.queue.enqueuePublish(
          tx,
          { id: adaptation.id, orgId, channelId: adaptation.channelId, attemptCount },
          scheduledAt,
        );
      }

      await this.setItemStatus(tx, orgId, id, "approved");
    });

    return this.get(orgId, id);
  }

  /**
   * Rejects an item AND stops anything it already had in flight.
   *
   * Flipping `content_items.status` alone was not a rejection at all: the
   * adaptations stayed `queued`/`scheduled`, their pg-boss jobs stayed live,
   * and the worker never looked at the parent item — so approving with a
   * schedule and then rejecting still published the post the next day. Every
   * outstanding adaptation goes back to `pending` and its job is cancelled, in
   * one transaction with the status write, so the queue can never disagree
   * with the database.
   *
   * `publishing` counts as outstanding, and leaving it out stranded the row
   * for good. A transient platform failure leaves the adaptation `publishing`
   * for the whole retry chain (`recordTransient` deliberately does not move
   * the status). A reject during that window used to match nothing: no job
   * cancelled, no status reset — and then the next retry loaded the item, saw
   * `rejected` and returned normally, which completes the job and ends the
   * chain. That also removed the dead-letter delivery that would otherwise
   * have terminated the row, so the adaptation sat in `publishing` forever
   * with no job behind it, and re-approve (which skips `publishing`) silently
   * did nothing.
   *
   * `attempt_count` advances for each cancelled job: a cancelled pg-boss row
   * keeps its id, so without the bump a later re-approve would derive the same
   * id, `send()` would suppress it as a duplicate, and the re-approve would
   * 409 forever (see `publishJobId`).
   *
   * A PUBLISHED item is the one case where none of that is available, and it
   * is refused with a 409 (`requireNotPublished`) rather than accepted. The
   * promise above — "rejects an item AND stops anything it already had in
   * flight" — is not something this method can keep once the post is live in
   * someone's channel; all a 200 bought was a row that said `rejected` about a
   * published post. Saying so out loud is the honest answer, and it is the one
   * the UI can render.
   */
  async reject(orgId: string, id: string) {
    await db.transaction(async (tx) => {
      await this.requireItem(tx, orgId, id);
      const outstanding = await this.lockAdaptations(tx, orgId, id, [
        ...OUTSTANDING_ADAPTATION_STATUSES,
      ]);
      await this.requireNotPublished(tx, orgId, id);

      for (const adaptation of outstanding) {
        await this.queue.cancelPublish(tx, adaptation.id, orgId);
        await tx
          .update(schema.adaptations)
          .set({
            status: "pending",
            scheduledAt: null,
            attemptCount: adaptation.attemptCount + 1,
            // Cleared for the same reason `approve` clears it: the row is back
            // to "nothing has been attempted", and leaving the last platform
            // error behind makes a rejected adaptation look like a failed one.
            lastError: null,
          })
          .where(
            and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptation.id)),
          );
      }

      await this.setItemStatus(tx, orgId, id, "rejected");
    });

    return this.get(orgId, id);
  }
}
