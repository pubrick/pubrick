import { createHash } from "node:crypto";
import { ConflictException, Injectable, Logger } from "@nestjs/common";
import {
  type AiCredential,
  type StepBrand,
  type StepChannel,
  type TemplateSnapshot,
  validateTemplateSnapshot,
} from "@pubrick/ai";
import { schema } from "@pubrick/db";
import {
  type AcceptedClaimCorrectionDto,
  type AcceptedClaimCorrectionListDto,
  ADAPTATION_STATUSES,
  type AdaptationProposal,
  type AdaptationStatus,
  type AdaptationUpdate,
  type AiVersionRow,
  type ApiErrorCode,
  adaptationLimit,
  allSentencesAi,
  type ClaimCorrectionProposalDto,
  type ClaimCorrectionRequest,
  type ClaimReviewClaim,
  CONTENT_PAGE_SIZE,
  CONTENT_STATUSES,
  COVER_SUPPORTED_PLATFORMS,
  type ContentCreate,
  type ContentCursor,
  type ContentStatus,
  type ContentUpdate,
  type ContentVersionRestore,
  type DeliveryOutcome,
  type DraftRevisionProposal,
  type DraftRevisionRequest,
  decodeContentCursor,
  encodeContentCursor,
  isMalformedStoredAiCredential,
  isManualPlatform,
  isSameText,
  isUnreadableCiphertext,
  MAX_BODY_LENGTH,
  MAX_CONTENT_PAGE_SIZE,
  MAX_REFINE_CALLS_PER_HOUR,
  MIN_RESCHEDULE_LEAD_MS,
  nextItemStatus,
  normalizeForComparison,
  normalizeHashtags,
  normalizeNewlines,
  OUTSTANDING_ADAPTATION_STATUSES,
  PROMPT_ROLES,
  type PromptRole,
  planRefineAccept,
  projectRichBody,
  type RefineAcceptPlan,
  type RefineProposal,
  type RefineRequest,
  type RefineVerb,
  type RichBody,
  type RunInput,
  refusalBody,
  replaceHashtags,
  richBodySchema,
  stripHashtagSuffix,
  TELEGRAM_PHOTO_CAPTION_LENGTH,
  telegramPostParts,
  toLedgerCostUsd,
  withHashtags,
} from "@pubrick/shared";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { z } from "zod";
import { AiCredentialsRepository } from "../ai-credentials/ai-credentials.repository";
import { badRequest, conflict, notFound } from "../api-error";
import { requireClientReviewApproval } from "../client-review/client-review.repository";
import { db } from "../db";
import { QueueService } from "../queue/queue.service";
import { ClaimCorrectionCaller } from "./claim-correction.caller";
import { CLAIM_CORRECTION_STEP } from "./claim-correction.step";
import { assertImagesFitBody } from "./content-images.repository";
import { DraftRevisionCaller } from "./draft-revision.caller";
import { DRAFT_REVISION_STEP } from "./draft-revision.step";
import { ReadaptCaller } from "./readapt.caller";
import { RefineCaller, type RefineFailure, type RefineUsage } from "./refine.caller";
import { REFINE_STEP } from "./refine.step";
import { safeRichHtmlBlocks } from "./rich-html";

/**
 * EVERY COLUMN OF AN ITEM THE API READS — one allowlist, and `body` is in it.
 *
 * An earlier draft of this commit declared a second constant beside this one,
 * `ITEM_LIST_COLUMNS` without the text, called it what `GET /api/content`
 * selects, and then never selected it: `list` read these columns and dropped
 * the body in JS. A constant that names the projection without being the
 * projection is worse than no constant, so it is gone and this docstring says
 * plainly what happens.
 *
 * A SLIM LIST PROJECTION IS NOT AVAILABLE HERE, and that is a dependency rather
 * than an omission. Every card carries `bodyIsAiVerbatim`, which is
 * `allSentencesAi` asked of the item's own text — the same formula the publish
 * gate runs — so there is no answering it without the body. Selecting the
 * card's columns and reading the bodies separately would move the same bytes
 * out of Postgres in two round trips instead of one.
 *
 * So what design 0009 measured is saved ON THE WIRE and nowhere else: `list`
 * strips `body` from every row before it returns, which was 44 % of a response
 * the browser re-reads every five seconds while anything is publishing. The
 * database read is the size it always was. The wire shape has its own
 * declaration in `@pubrick/shared` — `contentListItemDtoSchema`, a
 * `strictObject` — which is what a test can hold the stripping to.
 */
const ITEM_COLUMNS = {
  id: schema.contentItems.id,
  brandId: schema.contentItems.brandId,
  title: schema.contentItems.title,
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
  body: schema.contentItems.body,
  qualityScore: schema.contentItems.qualityScore,
};

function validStoredRichBody(value: unknown, body: string): RichBody | null {
  if (value == null) return null;
  const parsed = richBodySchema.safeParse(value);
  if (!parsed.success || projectRichBody(parsed.data) !== body) {
    Logger.error("Invalid stored rich document; returning plain text", "ContentRepository");
    return null;
  }
  return parsed.data;
}

function bodyRevisionConflict(revision: number): ConflictException {
  return new ConflictException({
    ...refusalBody(409, "version_changed", "This post changed; reload before saving"),
    bodyRevision: revision,
  });
}

/** Validate the exact reviewed text the Telegram publisher will receive. */
function telegramTextProblem(body: string, covered: boolean, video: boolean): string | null {
  if (video && body.length > TELEGRAM_PHOTO_CAPTION_LENGTH) {
    return "Telegram video captions must be 1024 characters or fewer";
  }
  try {
    telegramPostParts(body, covered);
    return null;
  } catch (error) {
    if (error instanceof RangeError) return error.message;
    throw error;
  }
}

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
 * `partially_published` IS in the set for the same reason carried one step
 * further, and it is the reason Reject can no longer be the way out of it
 * (`requireNotPublished`, the fan-out reach): rejecting a post that is live in
 * one channel would write `rejected` over it and nothing brings it back, so
 * reject either refuses (nothing outstanding) or cancels what has not gone and
 * leaves the item HERE (`reject`) — never `rejected`. If the text were pinned
 * here too there would then be no way left to correct the channel that refused
 * it — and the commonest permanent failure IS the text. What it costs
 * is stated rather than hidden: `update` rewrites `content_items.body` and
 * files the NEW text as the human version, so the product's own history does
 * not keep what already went out. That survives only as the receipt and the
 * live post (`publications.external_url`) — which is why the design (§4.3) has
 * the editor name the channels that already received the previous text.
 *
 * `as const satisfies` rather than a `readonly ContentStatus[]`
 * annotation: both make a typo a compile error, but this one also keeps the
 * literal member types, which is what lets `PINNED_ITEM_MESSAGE` below be
 * exhaustive by construction.
 */
const EDITABLE_ITEM_STATUSES = [
  "draft",
  "partially_published",
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
  archived: "Restore this archived content before editing it",
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
  archived: "content_archived",
};

/** States in which a channel can still send without another approval. */
const ACTIVE_ARCHIVE_DELIVERY_STATUSES = [
  "manual_ready",
  "scheduled",
  "queued",
  "publishing",
] as const satisfies readonly AdaptationStatus[];

/**
 * HOW FAR "already published" reaches, for the one gate both decisions go
 * through (`requireNotPublished`).
 *
 * Words rather than a boolean, and the words are the question rather than the
 * answer: a `published: true` flag at a call site says nothing about what it
 * is asking, and the two callers are asking about different rows — `approve`
 * about the item, `reject` about any one of its channels. Spelled out in full
 * at the call site, so the difference is legible where the decision is made
 * rather than in a signature two thousand lines away.
 *
 * `hasOutstanding` RIDES ON THE FAN-OUT REACH RATHER THAN BEING A FIFTH
 * PARAMETER, because the gate cannot answer reject's question without it and a
 * defaulted argument is exactly how it would come to be forgotten. "Any
 * adaptation is published" is TWO states — a fan-out that has finished
 * disagreeing, and one with a live post and a send still on its way — and
 * reject may only refuse the first (see the method). Reject is holding
 * `lockAdaptations`' rows when it asks, so it is the one place that knows,
 * and the union makes the answer impossible to omit.
 */
type Reach =
  | { readonly of: "the item" }
  | { readonly of: "the fan-out"; readonly hasOutstanding: boolean };

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
  manual_ready: "This post is ready for manual publishing; reject it before editing",
  scheduled: "A scheduled post cannot be edited; reject the content first",
  queued: "A post already queued for publishing cannot be edited; reject the content first",
  publishing: "A post that is being published right now cannot be edited; reject the content first",
  published: "This channel's post has already been published and can no longer be edited",
};

/** The same per-status refusals as codes — see `PINNED_ITEM_CODE`. */
const PINNED_ADAPTATION_CODE: Record<PinnedAdaptationStatus, ApiErrorCode> = {
  manual_ready: "adaptation_pinned_manual_ready",
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

const DRAFT_REVISION_COLUMNS = {
  id: schema.draftRevisionProposals.id,
  sourceBody: schema.draftRevisionProposals.sourceBody,
  instruction: schema.draftRevisionProposals.instruction,
  proposal: schema.draftRevisionProposals.proposal,
  reason: schema.draftRevisionProposals.reason,
};

const CLAIM_CORRECTION_COLUMNS = {
  id: schema.claimCorrectionProposals.id,
  contentItemId: schema.claimCorrectionProposals.contentItemId,
  reviewId: schema.claimCorrectionProposals.reviewId,
  claimIndex: schema.claimCorrectionProposals.claimIndex,
  sourceBody: schema.claimCorrectionProposals.sourceBody,
  sourceBodyHash: schema.claimCorrectionProposals.sourceBodyHash,
  claim: schema.claimCorrectionProposals.claim,
  replacement: schema.claimCorrectionProposals.replacement,
  reason: schema.claimCorrectionProposals.reason,
  evidence: schema.claimCorrectionProposals.evidence,
  createdAt: schema.claimCorrectionProposals.createdAt,
};

const ACCEPTED_CORRECTION_COLUMNS = {
  id: schema.acceptedClaimCorrections.id,
  contentItemId: schema.acceptedClaimCorrections.contentItemId,
  reviewId: schema.acceptedClaimCorrections.reviewId,
  fragmentVersionId: schema.acceptedClaimCorrections.fragmentVersionId,
  claimIndex: schema.acceptedClaimCorrections.claimIndex,
  sourceBodyHash: schema.acceptedClaimCorrections.sourceBodyHash,
  claim: schema.acceptedClaimCorrections.claim,
  replacement: schema.acceptedClaimCorrections.replacement,
  reason: schema.acceptedClaimCorrections.reason,
  evidence: schema.acceptedClaimCorrections.evidence,
  acceptedAt: schema.acceptedClaimCorrections.acceptedAt,
};

function acceptedCorrectionDto(row: {
  id: string;
  contentItemId: string;
  reviewId: string;
  fragmentVersionId: string;
  claimIndex: number;
  sourceBodyHash: string;
  claim: string;
  replacement: string;
  reason: string;
  evidence: ClaimReviewClaim["evidence"];
  acceptedAt: Date;
}): AcceptedClaimCorrectionDto {
  return { ...row, acceptedAt: row.acceptedAt.toISOString() };
}

function claimCorrectionDto(row: {
  id: string;
  contentItemId: string;
  reviewId: string;
  claimIndex: number;
  sourceBody: string;
  claim: string;
  replacement: string;
  reason: string;
  evidence: ClaimReviewClaim["evidence"];
  createdAt: Date;
}): ClaimCorrectionProposalDto {
  return {
    id: row.id,
    contentItemId: row.contentItemId,
    reviewId: row.reviewId,
    claimIndex: row.claimIndex,
    sourceBody: row.sourceBody,
    claim: row.claim,
    replacement: row.replacement,
    reason: row.reason,
    evidence: row.evidence,
    createdAt: row.createdAt.toISOString(),
  };
}

const ADAPTATION_PROPOSAL_COLUMNS = {
  id: schema.adaptationProposals.id,
  adaptationId: schema.adaptationProposals.adaptationId,
  proposal: schema.adaptationProposals.proposal,
  reason: schema.adaptationProposals.reason,
  masterBody: schema.adaptationProposals.masterBody,
  previousBody: schema.adaptationProposals.previousBody,
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
 * THE BODY HANDED IN IS THE CANONICAL ONE, and the caller's offsets are read
 * against it. `DimmedTextarea` renders `normalizeNewlines(value)` and reports
 * its offsets against that string, and a `<textarea>` strips CR from its value
 * whatever the API sent — so the editor's coordinates are the canonical body's,
 * never the stored one's. Slicing a raw CR body with them would hand the model
 * a selection the reader never made and stage an anchor Accept — which
 * normalises first — can no longer find.
 *
 * TWO REFUSALS, both `invalid_request`, and the code is a judgement rather than
 * a shrug. `API_ERROR_CODES` keeps one code for the whole validation boundary
 * because the alternative is a translated sentence per field per rule; these
 * two are that boundary's own kind of fault — a request describing a string the
 * server does not have — and the schema cannot make them because it cannot see
 * the body. The reader's sentence ("check what you entered") is true of both.
 *
 *  - A range past the end of the body. The caller is indexing text this server
 *    does not hold: a draft that moved under them, or offsets taken against
 *    some other string entirely.
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

/**
 * The one sentence `approve` answers with when a delivery nobody can speak for
 * is in the way, said once because it is thrown from two places: a timed
 * request that would skip such a row, and a request of any kind left with
 * nothing else to send. Both refuse the same act for the same reason, and two
 * copies would be free to drift into saying different things about it.
 */
const DELIVERY_OUTCOME_UNKNOWN_MESSAGE =
  "This post was sent to its channel and the platform never confirmed it, so it may already be " +
  "live; open the channel, then say what you found before sending again";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const ADAPTATION_COLUMNS = {
  id: schema.adaptations.id,
  contentItemId: schema.adaptations.contentItemId,
  channelId: schema.adaptations.channelId,
  body: schema.adaptations.body,
  hashtags: schema.adaptations.hashtags,
  cta: schema.adaptations.cta,
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
   * WHICH KIND OF FAILURE THIS WAS — `adaptations.failure_reason`, the closed
   * `PUBLISH_FAILURE_REASONS` code the worker stamps beside the sentence.
   *
   * Shipped because a screen has to tell a missed slot from a dead credential
   * from the platform's own refusal, and `last_error` cannot answer that: it is
   * free text, half of it written by the platform, and this product has already
   * shipped the bug where the web read a worker sentence's prefix to decide
   * behaviour (`apps/web/src/lib/adaptations.ts`: a reworded log line turned
   * every unknown delivery back into a plain red Failed). The code says the
   * CLASS, the sentence stays the platform's own words, and `platform_rejected`
   * is the one class where the screen still prints them.
   *
   * `null` is not an "other" bucket — every writer that lands a row on a
   * verdict names a reason and every writer that moves it off one clears the
   * column (`@pubrick/shared`, `PUBLISH_FAILURE_REASONS`). It survives for
   * exactly one population: rows that failed before the column existed, which
   * the screens render from `last_error` as they always did.
   */
  failureReason: schema.adaptations.failureReason,
  /**
   * HOW LATE THE DELIVERY THAT FAILED WAS, in seconds — the number the missed-slot
   * sentence on the screens says out loud, and `null` on every row that is not
   * one.
   *
   * MEASURED AT THE REFUSAL, NOT NOW. The worker never clears `scheduled_at` on
   * a failure, so `now() - scheduled_at` read at render time would grow for
   * ever: the same post would be "3 h late" this morning and "2 days late"
   * tomorrow, and each reading would disagree with the frozen sentence stored
   * beside it. The receipt's `created_at` is the instant the attempt that
   * refused was claimed, and it does not move again.
   *
   * THE SAME RECEIPT `deliveryOutcome` AND `assertedByName` READ, by the same
   * predicate — the LAST FINISHED attempt (`status <> 'in_flight'`, ordered
   * `created_at desc`). Three fields captioning one row off three different
   * attempts is how a screen tells a story about a delivery that never
   * happened; they are one receipt or they are nothing.
   *
   * Scoped to `failed` adaptations with a slot. A `published` row is not late,
   * it is late-or-not history nobody asked about; an unscheduled one ("publish
   * now") has no slot to have missed, which is exactly why the worker's own
   * bound answers null for it.
   *
   * Deliberately NOT parsed out of `last_error`. The hours are in that
   * sentence, and reading them back out of prose is the defect one field up.
   */
  lateBySeconds: sql<number | null>`(
    case
      when adaptations.status = 'failed' and adaptations.scheduled_at is not null
      then (
        select extract(epoch from p.created_at - adaptations.scheduled_at)
        from publications p
        where p.adaptation_id = adaptations.id and p.status <> 'in_flight'
        order by p.created_at desc
        limit 1
      )
    end
  )`.mapWith(Number),
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
   * Scoped to `published` and deliberately NOT widened to `unknown` receipts.
   * A generic unknown has no confirmed link; a partial Telegram receipt may
   * have a confirmed first-message link, which `partialTelegram` exposes separately.
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
   * labels a delivery from. Its values are documented on the union in
   * `@pubrick/shared`; this is where the seventh is computed.
   *
   * The adaptation column has six: `failed` is its only
   * terminal-and-not-published state, so a send whose answer never came back —
   * the post may be live in the channel, nothing here can tell — is stored as
   * `failed` too. The distinction lives on the `publications` receipt the
   * worker writes per attempt, whose status is `unknown` for exactly that
   * ending (`PublishService.recordUnknownOutcome`, and `sweepAbandoned` for an
   * attempt that died holding its in-flight claim). A confirmed Telegram cover
   * adds frozen partial data to that receipt and reads as `partial`. Rounding
   * either case back to
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
      when adaptations.status = 'failed' then coalesce((
        select case
          when p.status = 'unknown' and p.partial_followup_text is not null then 'partial'
          when p.status = 'unknown' then 'unknown'
          else null
        end
        from publications p
        where p.adaptation_id = adaptations.id and p.status <> 'in_flight'
        order by p.created_at desc
        limit 1
      ), adaptations.status)
      else adaptations.status
    end
  )`,
  /** The last unresolved Telegram multipart receipt, never reconstructed from log prose. */
  partialTelegram: sql<{
    primaryKind: "photo" | "message" | null;
    photoId: string | null;
    photoUrl: string | null;
    followupText: string;
    followupOutcome: "pending" | "not_sent" | "rejected" | "unknown" | "confirmed";
  } | null>`(
    select case
      when adaptations.status = 'failed' and p.status = 'unknown'
        and p.partial_followup_text is not null
      then json_build_object(
        'primaryKind', p.partial_primary_kind,
        'photoId', p.partial_photo_id,
        'photoUrl', p.partial_photo_url,
        'followupText', p.partial_followup_text,
        'followupOutcome', p.partial_followup_outcome
      )
      else null
    end
    from publications p
    where p.adaptation_id = adaptations.id and p.status <> 'in_flight'
    order by p.created_at desc
    limit 1
  )`,
  /**
   * WHO SAID THIS POST WAS DELIVERED, when no platform did — and WHEN they
   * said it. Null on every delivery a platform actually answered for, which is
   * almost all of them.
   *
   * WITHOUT THIS FIELD THE COLUMN IS INVISIBLE AND THE SCREEN LIES. A
   * `published` adaptation with no `external_url` renders `linkUnavailable`
   * ("published — link unavailable", `[id]/page.tsx`), which claims a
   * platform-confirmed delivery whose link went missing. A human assertion is
   * exactly what that is not: nobody ever had a link, because the answer that
   * would have carried one never arrived — a person opened the channel, saw the
   * post, and said so. The screen says whose word it is instead.
   *
   * THE SAME RECEIPT `deliveryOutcome` READS, and deliberately the same
   * predicate: the LAST FINISHED attempt (`status <> 'in_flight'`, ordered
   * `created_at desc`). Reading "the most recent asserted receipt" instead
   * would be a different and wrong question — an adaptation a person marked
   * undelivered, re-approved, and the worker then genuinely published would
   * still name that person beside the worker's own delivery.
   *
   * Which is why `asserted_by` is read INSIDE the row the ordering picked
   * rather than joined across it. An inner join to `user` would drop a receipt
   * with no asserter and hand the `limit 1` an OLDER one, producing that exact
   * lie by a different road.
   *
   * `deliveryOutcome` is unchanged by any of this, and that is the decision:
   * a human's verdict is an ordinary outcome, so every reader that already
   * knows what `published` and `failed` mean needs no teaching. The sentence on
   * the screen is the only place the difference shows.
   */
  assertedByName: sql<string | null>`(
    select u.name from "user" u where u.id = (
      select p.asserted_by from publications p
      where p.adaptation_id = adaptations.id and p.status <> 'in_flight'
      order by p.created_at desc
      limit 1
    )
  )`,
  /**
   * WHEN A PERSON SETTLED IT — read from `asserted_at`, and deliberately NOT
   * derived from `asserted_by`.
   *
   * The column above is `ON DELETE SET NULL`: the pointer goes when the account
   * does, and that is the decision — a receipt outlives what it points at, and
   * what a departure costs is the name. Gating this timestamp on that pointer
   * would make the cost the FACT: the row would answer null for a delivery a
   * person really did settle, and the screen would fall back to "published —
   * link unavailable", claiming the platform confirmation nobody ever got —
   * the exact lie `asserted_by` was added to prevent, arrived at by deleting an
   * account. `asserted_at` is written beside it by the resolver and nothing can
   * null it, so `assertedByName` null with `assertedAt` set is a real state
   * with its own sentence on the screen: a removed member, and the date.
   *
   * The same receipt and the same predicate as `assertedByName` — the LAST
   * FINISHED attempt — for the reason given there.
   */
  assertedAt: sql<Date | null>`(
    select p.asserted_at from publications p
    where p.adaptation_id = adaptations.id and p.status <> 'in_flight'
    order by p.created_at desc
    limit 1
  )`,
};

// A queue card needs the delivery verdict, but never the frozen missing reply.
// Keep its projection narrow: the list is polled and can contain 200 channels.
const { partialTelegram: _detailOnly, ...ADAPTATION_LIST_COLUMNS } = ADAPTATION_COLUMNS;
type AdaptationListRow = Omit<
  Awaited<ReturnType<ContentRepository["adaptationsFor"]>>[number],
  "partialTelegram"
>;

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

/**
 * `column = ANY($n::uuid[])` — one bind parameter for a whole page of ids.
 *
 * drizzle's `inArray` emits `in ($2, $3, …)`, a placeholder per element.
 * Postgres refuses a statement with more than 65 535 of them, and the two reads
 * that take a page of item ids have no `LIMIT` over them until design 0009's
 * cursor lands — the page is however many items an organisation owns. A list
 * that is merely slow at ten thousand drafts becomes one that cannot be
 * answered at all, which is a different kind of defect and not one to leave for
 * a later commit to bound.
 *
 * The array goes as a single parameter (`sql.param`, so drizzle sends the JS
 * array rather than splicing it into the text) and is cast, because a bare
 * parameter has no type Postgres can compare against a `uuid` column.
 */
function anyOf(column: PgColumn, ids: string[]) {
  return sql`${column} = any(${sql.param(ids)}::uuid[])`;
}

/** What `GET /api/content` accepts, exactly as the query string carries it. */
export type ContentListOptions = {
  status?: string;
  /** Still a string: it comes off a URL, and refusing a bad one is this file's job. */
  limit?: string;
  cursor?: string;
};

/**
 * THE SORT KEY, RENDERED BY POSTGRES, AT THE PRECISION POSTGRES KEEPS IT.
 *
 * Not `item.createdAt`. The driver hands back a JS `Date`, which holds
 * milliseconds, while `created_at` is `timestamptz` and holds microseconds — so
 * a cursor built from the `Date` names an instant slightly EARLIER than the row
 * it came from, `(created_at, id) < cursor` does not exclude that row, and the
 * last card of a page comes back as the first card of the next one. The defect
 * is invisible on any fixture whose timestamps happen to land on a whole
 * millisecond, which is most of them.
 *
 * `to_char(... 'US')` in UTC, so the string is an ISO-8601 instant with six
 * fractional digits regardless of the session's `TimeZone` — the form
 * `decodeContentCursor` is the only accepter of, and the form bound straight
 * back as `timestamptz` below. It is stripped from every row before the wire,
 * like `body`.
 */
const CURSOR_AT = sql<string>`to_char(${schema.contentItems.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * The keyset predicate: everything strictly AFTER this position in the queue's
 * own order.
 *
 * A ROW COMPARISON, `(created_at, id) < (a, b)`, not `created_at < a OR
 * (created_at = a AND id < b)`. The two are equivalent and only one of them is
 * an index condition: Postgres matches a row-wise comparison against a
 * multicolumn btree, which is what lets this seek
 * `content_items_org_id_created_at_id_idx` instead of sorting the organisation
 * first. The EXPLAIN in `content-list-cost.e2e.spec.ts` is what holds that.
 *
 * STRICTLY `<`. `<=` would re-serve the cursor row as the first card of the
 * next page — and with `created_at` alone as the key it would re-serve every
 * row sharing that instant, which the generate worker produces by the
 * transaction-load: `now()` is one value for every row a transaction writes.
 *
 * The casts are what a bare parameter needs to be comparable to its column;
 * `sql.param` keeps both values out of the statement text.
 */
function afterCursor(cursor: ContentCursor) {
  return sql`(${schema.contentItems.createdAt}, ${schema.contentItems.id}) < (${sql.param(cursor.createdAt)}::timestamptz, ${sql.param(cursor.id)}::uuid)`;
}

/**
 * How many cards this request may have, or a 400.
 *
 * REFUSED ABOVE THE CEILING RATHER THAN CLAMPED. Serving 200 to a caller that
 * asked for 5 000 lets it go on believing it has the whole queue, which is the
 * exact belief the bound exists to take away — and it is the belief every
 * caller of this endpoint held until this commit. A non-integer, a zero and a
 * negative are refused for the same reason: `?limit=0` is a request nobody
 * meant, and answering it with the default would be inventing an intent.
 */
function parsePageLimit(raw: string | undefined): number {
  if (raw === undefined) return CONTENT_PAGE_SIZE;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CONTENT_PAGE_SIZE) {
    throw badRequest(
      "invalid_request",
      `limit must be an integer between 1 and ${MAX_CONTENT_PAGE_SIZE}; got ${raw}`,
    );
  }
  return limit;
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
    private readonly readapter: ReadaptCaller,
    private readonly draftReviser: DraftRevisionCaller,
    private readonly claimCorrector: ClaimCorrectionCaller,
  ) {}

  /**
   * One item's channel strip, IN THE ORDER THE CHANNELS WERE ADDED.
   *
   * `created_at, id`, the same order `lockAdaptations` and the version reads
   * use, and for the same reason each time: the item screen and the queue card
   * render these rows straight through, so the order they come back in is the
   * order a reader sees, and without a clause it is the planner's. The `id`
   * tiebreak is not decoration here either — `POST /api/content` inserts every
   * channel's adaptation in ONE statement, where `now()` is a single value.
   */
  private async adaptationsFor(orgId: string, contentItemId: string) {
    return db
      .select(ADAPTATION_COLUMNS)
      .from(schema.adaptations)
      .where(
        and(
          eq(schema.adaptations.orgId, orgId),
          eq(schema.adaptations.contentItemId, contentItemId),
        ),
      )
      .orderBy(asc(schema.adaptations.createdAt), asc(schema.adaptations.id));
  }

  /**
   * The channel strips of MANY items at once, keyed by item — one query for a
   * whole list, where `list` used to make one per card.
   *
   * `= ANY($ids)` — one bind parameter for the whole page (`anyOf` above says
   * why it is not drizzle's `inArray`), exactly what `itemAiEvidence` below
   * also does, and grouped in JS. The old shape was `items.map(async …)`
   * over `adaptationsFor`: 500 statements for a 500-item queue, fired at once
   * through a `Promise.all` at a `pg.Pool` that has TEN clients and is shared
   * with better-auth and every other repository — so one long queue in one tab
   * put a thousand statements in front of every other request in the process.
   * Wall time was never the complaint (110 ms warm, measured); the pool was.
   *
   * The same verdict columns as the item detail, minus `partialTelegram`:
   * its frozen missing reply belongs on the authenticated detail screen, not
   * on every queue card. `deliveryOutcome` and `externalUrl` keep their one SQL
   * definition in `ADAPTATION_COLUMNS`.
   * Their correlated subqueries still run once per adaptation ROW; what this
   * removes is the round TRIP per item.
   *
   * Every requested id gets an entry, empty array included. A missing key and
   * an empty one are the same card — a draft whose channels were all deleted —
   * and `list` must not turn one into a row with no `adaptations` field at all.
   */
  private async adaptationsForMany(
    orgId: string,
    contentItemIds: string[],
  ): Promise<Map<string, AdaptationListRow[]>> {
    const byItem = new Map<string, AdaptationListRow[]>(contentItemIds.map((id) => [id, []]));
    if (contentItemIds.length === 0) return byItem;
    const rows = await db
      .select(ADAPTATION_LIST_COLUMNS)
      .from(schema.adaptations)
      .where(
        and(
          eq(schema.adaptations.orgId, orgId),
          anyOf(schema.adaptations.contentItemId, contentItemIds),
        ),
      )
      // The same `created_at, id` as the single-item read above, and it has to
      // be stated rather than inherited: grouping preserves the order rows
      // ARRIVE in, and one page's rows arrive from a scan over every item on
      // it — so without this, one draft's channel strip depends on what other
      // drafts are on the same page.
      .orderBy(asc(schema.adaptations.createdAt), asc(schema.adaptations.id));
    for (const row of rows) byItem.get(row.contentItemId)?.push(row);
    return byItem;
  }

  /**
   * The item-level `ai` version evidence for many items at once, keyed by item.
   *
   * `list` needs the badge's answer for every card, and the badge's answer is
   * the gate's question asked of these rows. One `IN` query rather than a read
   * per item: this is already an N+1 for adaptations, and the cure for that is
   * not a second one. One bind parameter for the page, like the read above —
   * see `anyOf`.
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
          anyOf(schema.contentVersions.contentItemId, itemIds),
          isNull(schema.contentVersions.adaptationId),
          eq(schema.contentVersions.origin, "ai"),
        ),
      )
      .orderBy(asc(schema.contentVersions.createdAt), asc(schema.contentVersions.id));
    return collectAiEvidence(rows, (row) => row.contentItemId);
  }

  /**
   * ONE PAGE OF THE QUEUE, and where the next one starts.
   *
   * Answers `{ rows, nextCursor }` — a PAIR FOR THE CONTROLLER, never an
   * envelope on the wire. The controller puts `nextCursor` in the
   * `X-Next-Cursor` header and answers with `rows` alone, so the body of this
   * list, like every other list in this api, stays a bare array; see
   * `NEXT_CURSOR_HEADER` for the ratchet that makes that a rule rather than a
   * taste. The row type is inferred from the projection below on purpose: it is
   * `ITEM_COLUMNS` minus the two fields stripped on the way out, plus the badge
   * and the channel strip, and a hand-written copy of that would be a second
   * declaration free to drift from the one that is actually returned.
   * `contentListItemDtoSchema` (`@pubrick/shared`) is the wire shape, asserted
   * in the api's own e2e.
   */
  async list(
    orgId: string,
    options: ContentListOptions = {},
    visibleBrandIds: string[] | null = null,
  ) {
    const { status, cursor: rawCursor } = options;
    // CODED, like every other refusal on this route. A bare
    // `BadRequestException` carries no `code`, and `errorMessage` on the web
    // has nothing to translate — so the reader gets the api's English, which is
    // the exact failure the cursor refusal below is written to avoid.
    if (status !== undefined && !(CONTENT_STATUSES as readonly string[]).includes(status)) {
      throw badRequest(
        "invalid_request",
        `Unknown status: ${status}. Expected one of: ${CONTENT_STATUSES.join(", ")}`,
      );
    }
    const limit = parsePageLimit(options.limit);
    // A cursor this api did not write is a REFUSAL, never a page taken from
    // wherever the garbage happened to land. `decodeContentCursor` answers
    // `null` for every malformed form — see its docstring for why it does not
    // throw — and this is the one place that turns that into a 400 with a code
    // a screen can translate. Without it the value reaches drizzle and Postgres
    // raises `invalid input syntax for type timestamp with time zone`: a 500,
    // for a request the caller got wrong.
    const cursor = rawCursor === undefined ? null : decodeContentCursor(rawCursor);
    if (rawCursor !== undefined && cursor === null) {
      throw badRequest("invalid_request", `Malformed cursor: ${rawCursor}`);
    }
    const where = and(
      eq(schema.contentItems.orgId, orgId),
      visibleBrandIds === null ? undefined : inArray(schema.contentItems.brandId, visibleBrandIds),
      // Safe: membership just verified above, so the widened `string` really is one
      // of the literal statuses drizzle's column type expects.
      status
        ? eq(schema.contentItems.status, status as ContentStatus)
        : ne(schema.contentItems.status, "archived"),
      cursor ? afterCursor(cursor) : undefined,
    );
    const page = await db
      .select({ ...ITEM_COLUMNS, cursorAt: CURSOR_AT })
      .from(schema.contentItems)
      .where(where)
      // NEWEST FIRST, TIES BROKEN BY `id`. This query had no `ORDER BY` of any
      // kind, so the queue's card order was whatever the planner returned —
      // stable enough on a small table to pass for a decision, and a promise
      // nothing was keeping. The tiebreak is not decoration: the generate
      // worker writes an item inside one transaction, where `now()` is a
      // single value, and two drafts stamped in the same one would otherwise
      // swap places between two reads of an unchanged queue — and under the
      // `LIMIT` below it decides WHICH items a page contains, not merely the
      // order they are drawn in. `content_items_org_id_created_at_id_idx`
      // (migration 0020) is this exact sort, and the keyset page seeks it
      // (`content-list-cost.e2e.spec.ts` EXPLAINs the real statement).
      .orderBy(desc(schema.contentItems.createdAt), desc(schema.contentItems.id))
      // ONE MORE ROW THAN THE PAGE, which is how "is there a next page?" is
      // answered without a second query and without a `COUNT(*)` over the whole
      // organisation. The extra row is never rendered and never serialised — it
      // is READ whole, `body` included, because the projection is
      // `ITEM_COLUMNS`, which is one row's worth of waste per page.
      .limit(limit + 1);
    const hasNext = page.length > limit;
    const items = hasNext ? page.slice(0, limit) : page;
    const itemIds = items.map((item) => item.id);
    // Two independent reads of the same page, so they go together: neither
    // needs the other's answer, and the pool is the resource being spared.
    const [aiEvidence, adaptations] = await Promise.all([
      this.itemAiEvidence(orgId, itemIds),
      this.adaptationsForMany(orgId, itemIds),
    ]);
    const rows = items.map((item) => {
      // The gate's question, on the card. See `get` for why the badge is a
      // boolean the server computes rather than a comparison the browser runs.
      const evidence = aiEvidence.get(item.id) ?? NO_AI_EVIDENCE;
      // `body` is READ and not RETURNED, and the two halves of that have
      // different reasons. It is read because the badge below is
      // `allSentencesAi` asked of this very text — the same formula the publish
      // gate runs — and there is no answering that without the body. It is not
      // returned because nothing on the queue screen renders it: the card shows
      // a title, a status, a badge and a channel strip (`apps/web/src/app/
      // [locale]/content/page.tsx`, whose `ContentItem` type has never had a
      // `body`). So the saving is the WIRE and the browser's five-second poll,
      // not the database read — see `ITEM_COLUMNS`. This line IS the list's
      // projection; there is no narrower SELECT behind it.
      //
      // `cursorAt` leaves by the same door and for a plainer reason: it is the
      // sort key rendered for the CURSOR, and a caller that read it off a row
      // would be reading the ordering this api reserves the right to change.
      const { body, cursorAt: _cursorAt, ...card } = item;
      return {
        ...card,
        bodyIsAiVerbatim: allSentencesAi(body, evidence.rows, evidence.firstFullBody),
        adaptations: adaptations.get(item.id) ?? [],
      };
    });
    // The LAST ROW OF THE PAGE, not the extra one: the cursor means "start
    // after this", so the next page begins at the row that was cut off.
    const last = items[items.length - 1];
    return {
      rows,
      nextCursor:
        hasNext && last ? encodeContentCursor({ createdAt: last.cursorAt, id: last.id }) : null,
    };
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
   * The run that produced this item — its id and what it was asked for — or
   * `null`. The receipt's address, in the reverse direction, plus the
   * attribution the draft screen shows beside it.
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
   * name a stranger's receipt — and, since this now returns the run's `input`
   * as well, to reprint the article that stranger pasted as this draft's own
   * provenance.
   *
   * `input` rides along on a query that already runs, which is what the whole
   * source strip costs: no new index (the read is by `(org_id,
   * content_item_id)` under `pipeline_runs_org_id_idx`, exactly as the shipped
   * link is) and no new endpoint. WHAT IT CANNOT DO, and the cost the design
   * accounted as zero: a draft whose run row was deleted keeps its body and
   * loses its attribution. `content_item_id` is `ON DELETE SET NULL` and
   * carries no unique constraint, the run is deletable, and a `content_items`
   * row holds no source of its own — so the attribution is only as durable as
   * the run behind it, and there is no second place to read it from.
   *
   * `get()` only. `list()` does not read a run today and must not start: a
   * queue card says nothing about a source, and a list that carried one would
   * ship every open item's pasted article to draw cards that never mention it.
   */
  private async runFor(
    orgId: string,
    contentItemId: string,
    brandId: string,
  ): Promise<{ id: string; input: RunInput; topicId: string | null } | null> {
    const rows = await db
      .select({
        id: schema.pipelineRuns.id,
        input: schema.pipelineRuns.input,
        topicId: schema.topics.id,
      })
      .from(schema.pipelineRuns)
      .leftJoin(
        schema.topics,
        and(
          eq(schema.topics.id, schema.pipelineRuns.topicId),
          eq(schema.topics.orgId, orgId),
          eq(schema.topics.brandId, brandId),
        ),
      )
      .where(
        and(
          eq(schema.pipelineRuns.orgId, orgId),
          eq(schema.pipelineRuns.brandId, brandId),
          eq(schema.pipelineRuns.contentItemId, contentItemId),
        ),
      )
      .orderBy(asc(schema.pipelineRuns.createdAt), asc(schema.pipelineRuns.id))
      .limit(1);
    return rows[0] ?? null;
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
    const [
      adaptations,
      aiVersions,
      run,
      refineProposal,
      draftRevisionProposal,
      adaptationProposals,
      cover,
    ] = await Promise.all([
      this.adaptationsFor(orgId, item.id),
      this.aiVersionRows(orgId, item.id),
      this.runFor(orgId, item.id, item.brandId),
      this.stagedProposal(orgId, item.id),
      this.stagedDraftRevision(orgId, item.id),
      this.stagedAdaptationProposals(orgId, item.id),
      db
        .select({
          coverMediaId: schema.contentItems.coverMediaId,
          videoMediaId: schema.contentItems.videoMediaId,
          linkPolicyWebsite: schema.contentItems.linkPolicyWebsite,
          archivedFromStatus: schema.contentItems.archivedFromStatus,
          isSafeToDelete: schema.contentItems.isSafeToDelete,
          richBody: schema.contentItems.richBody,
          bodyRevision: schema.contentItems.bodyRevision,
        })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
        .limit(1),
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
    const richBody = validStoredRichBody(cover[0]?.richBody, item.body);
    return {
      ...item,
      coverMediaId: cover[0]?.coverMediaId ?? null,
      videoMediaId: cover[0]?.videoMediaId ?? null,
      linkPolicyWebsite: cover[0]?.linkPolicyWebsite ?? null,
      archivedFromStatus: cover[0]?.archivedFromStatus ?? null,
      isSafeToDelete: cover[0]?.isSafeToDelete ?? false,
      richBody,
      richBodyHtml: richBody ? (safeRichHtmlBlocks(richBody, item.body)?.join("\n") ?? null) : null,
      bodyRevision: cover[0]?.bodyRevision ?? 0,
      adaptations,
      /**
       * The run that made this item, so the delivery receipt stays reachable
       * from the finished draft (dossier §6.3). `null` for a hand-written item
       * — the ordinary case — and for one whose run row is gone.
       */
      runId: run?.id ?? null,
      topicId: run?.topicId ?? null,
      /**
       * What that run was asked for, so the draft can say where it came from —
       * "drafted from pasted text", with the host of the source as attribution
       * — without a second request against a run this screen would then have to
       * keep in step with the item it polls.
       *
       * The WHOLE input, not two flattened attribution fields: `RunInput` is
       * the column's own schema and the only thing the compiler can hold both
       * ends of this wire to, and a flattened pair would be a third
       * hand-written description of a column that has two already.
       */
      runInput: run?.input ?? null,
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
      draftRevisionProposal,
      adaptationProposals,
      aiVersionBodies,
    };
  }

  /**
   * Whole-body snapshots are read on demand. Putting them on `get()` would send
   * every earlier draft again on each item poll, while the editor only opens
   * history when a person asks for it. A version id is the page cursor: the
   * database supplies its full-precision timestamp, so a JavaScript Date never
   * rounds a page boundary and repeats or skips a version.
   */
  async versions(orgId: string, itemId: string, adaptationId?: string, cursor?: string) {
    const [item] = await db
      .select({ id: schema.contentItems.id })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, itemId)))
      .limit(1);
    if (!item) throw notFound("content_not_found", "Content item not found");
    if (adaptationId) {
      const [adaptation] = await db
        .select({ id: schema.adaptations.id })
        .from(schema.adaptations)
        .where(
          and(
            eq(schema.adaptations.orgId, orgId),
            eq(schema.adaptations.contentItemId, itemId),
            eq(schema.adaptations.id, adaptationId),
          ),
        )
        .limit(1);
      if (!adaptation) throw notFound("adaptation_not_found", "Adaptation not found");
    }
    const level = adaptationId
      ? eq(schema.contentVersions.adaptationId, adaptationId)
      : isNull(schema.contentVersions.adaptationId);
    let before: { id: string } | undefined;
    if (cursor) {
      [before] = await db
        .select({ id: schema.contentVersions.id })
        .from(schema.contentVersions)
        .where(
          and(
            eq(schema.contentVersions.orgId, orgId),
            eq(schema.contentVersions.contentItemId, itemId),
            eq(schema.contentVersions.scope, "full"),
            level,
            eq(schema.contentVersions.id, cursor),
          ),
        )
        .limit(1);
      if (!before) throw badRequest("invalid_request", "Unknown version cursor");
    }
    const page = await db
      .select({
        id: schema.contentVersions.id,
        adaptationId: schema.contentVersions.adaptationId,
        body: schema.contentVersions.body,
        richBody: schema.contentVersions.richBody,
        hashtags: schema.contentVersions.hashtags,
        cta: schema.contentVersions.cta,
        origin: schema.contentVersions.origin,
        createdAt: schema.contentVersions.createdAt,
      })
      .from(schema.contentVersions)
      .where(
        and(
          eq(schema.contentVersions.orgId, orgId),
          eq(schema.contentVersions.contentItemId, itemId),
          eq(schema.contentVersions.scope, "full"),
          level,
          before
            ? sql`(${schema.contentVersions.createdAt}, ${schema.contentVersions.id}) < (
                select created_at, id from content_versions
                where org_id = ${orgId} and content_item_id = ${itemId}
                  and scope = 'full'
                  and adaptation_id is not distinct from ${adaptationId ?? null}::uuid
                  and id = ${before.id}::uuid
              )`
            : undefined,
        ),
      )
      .orderBy(desc(schema.contentVersions.createdAt), desc(schema.contentVersions.id))
      .limit(21);
    return {
      rows: page.slice(0, 20).map((row) => ({
        ...row,
        richBody: validStoredRichBody(row.richBody, row.body),
      })),
      nextCursor: page.length > 20 ? (page[19]?.id ?? null) : null,
    };
  }

  /** Restoring is a human edit, even when its source was written by the model. */
  async restoreVersion(
    orgId: string,
    itemId: string,
    versionId: string,
    data: ContentVersionRestore,
    userId: string,
  ) {
    await db.transaction(async (tx) => {
      const [version] = await tx
        .select({
          body: schema.contentVersions.body,
          richBody: schema.contentVersions.richBody,
          hashtags: schema.contentVersions.hashtags,
          cta: schema.contentVersions.cta,
          adaptationId: schema.contentVersions.adaptationId,
        })
        .from(schema.contentVersions)
        .where(
          and(
            eq(schema.contentVersions.orgId, orgId),
            eq(schema.contentVersions.contentItemId, itemId),
            eq(schema.contentVersions.id, versionId),
            eq(schema.contentVersions.scope, "full"),
          ),
        )
        .limit(1);
      if (!version) throw notFound("version_not_found", "Saved version not found");

      if (version.adaptationId) {
        // An adaptation lock comes before the item lock throughout the product.
        // It also protects this version's FK target against a concurrent delete.
        const [adaptation] = await tx
          .select({
            status: schema.adaptations.status,
            channelId: schema.adaptations.channelId,
            body: schema.adaptations.body,
            hashtags: schema.adaptations.hashtags,
            cta: schema.adaptations.cta,
          })
          .from(schema.adaptations)
          .where(
            and(
              eq(schema.adaptations.orgId, orgId),
              eq(schema.adaptations.contentItemId, itemId),
              eq(schema.adaptations.id, version.adaptationId),
            ),
          )
          .limit(1)
          .for("update");
        if (!adaptation) throw notFound("adaptation_not_found", "Adaptation not found");
        const item = await this.requireEditableItem(tx, orgId, itemId);
        if (!isEditableAdaptationStatus(adaptation.status)) {
          throw conflict(
            PINNED_ADAPTATION_CODE[adaptation.status],
            PINNED_ADAPTATION_MESSAGE[adaptation.status],
          );
        }
        if (adaptation.body !== data.expectedBody) {
          throw conflict("version_changed", "This channel's text changed; reload before restoring");
        }
        if (data.expectedHashtags === undefined || data.expectedCta === undefined) {
          throw badRequest("invalid_request", "Channel restore requires current details");
        }
        if (
          JSON.stringify(adaptation.hashtags) !== JSON.stringify(data.expectedHashtags) ||
          adaptation.cta !== data.expectedCta
        ) {
          throw conflict(
            "version_changed",
            "This channel's details changed; reload before restoring",
          );
        }
        const [channel] = await tx
          .select({ platform: schema.channels.platform })
          .from(schema.channels)
          .where(
            and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, adaptation.channelId)),
          )
          .limit(1);
        if (!channel) throw notFound("channel_not_found", "Channel not found");
        const limit = adaptationLimit(channel.platform);
        if (limit === undefined || version.body.length > limit) {
          throw badRequest(
            "invalid_request",
            `Saved channel text exceeds ${limit ?? 0} characters`,
          );
        }
        if (channel.platform === "telegram") {
          const problem = telegramTextProblem(
            version.body,
            item.coverMediaId !== null,
            item.videoMediaId !== null,
          );
          if (problem) throw badRequest("invalid_request", problem);
        }
        if (
          adaptation.body !== version.body ||
          JSON.stringify(adaptation.hashtags) !== JSON.stringify(version.hashtags) ||
          adaptation.cta !== version.cta
        ) {
          await tx
            .update(schema.adaptations)
            .set({ body: version.body, hashtags: version.hashtags, cta: version.cta })
            .where(eq(schema.adaptations.id, version.adaptationId));
          await this.recordHumanVersion(tx, {
            orgId,
            contentItemId: itemId,
            adaptationId: version.adaptationId,
            body: version.body,
            hashtags: version.hashtags,
            cta: version.cta,
            createdBy: userId,
          });
        }
      } else {
        const item = await this.requireEditableItem(tx, orgId, itemId);
        if (data.expectedBody !== null && data.expectedBody.length > MAX_BODY_LENGTH) {
          throw badRequest(
            "invalid_request",
            `Expected post exceeds ${MAX_BODY_LENGTH} characters`,
          );
        }
        if (version.body.length > MAX_BODY_LENGTH) {
          throw badRequest("invalid_request", `Saved post exceeds ${MAX_BODY_LENGTH} characters`);
        }
        if (item.body !== data.expectedBody) {
          throw conflict("version_changed", "This post changed; reload before restoring");
        }
        if (item.richBody !== null && data.expectedBodyRevision === undefined) {
          throw bodyRevisionConflict(item.bodyRevision);
        }
        if (
          data.expectedBodyRevision !== undefined &&
          item.bodyRevision !== data.expectedBodyRevision
        ) {
          throw bodyRevisionConflict(item.bodyRevision);
        }
        const restoredRich = validStoredRichBody(version.richBody, version.body);
        if (
          item.body !== version.body ||
          JSON.stringify(item.richBody) !== JSON.stringify(restoredRich)
        ) {
          if (item.body !== version.body) {
            await this.requireInheritedTelegramText(
              tx,
              orgId,
              itemId,
              version.body,
              item.coverMediaId !== null,
              item.videoMediaId !== null,
            );
          }
          await assertImagesFitBody(tx, orgId, itemId, version.body);
          await tx
            .update(schema.contentItems)
            .set({ body: version.body, richBody: restoredRich })
            .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, itemId)));
          await this.recordHumanVersion(tx, {
            orgId,
            contentItemId: itemId,
            adaptationId: null,
            body: version.body,
            richBody: restoredRich,
            createdBy: userId,
          });
        }
      }
    });
    return this.get(orgId, itemId);
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

  private async stagedDraftRevision(
    orgId: string,
    contentItemId: string,
  ): Promise<DraftRevisionProposal | null> {
    const [proposal] = await db
      .select(DRAFT_REVISION_COLUMNS)
      .from(schema.draftRevisionProposals)
      .where(
        and(
          eq(schema.draftRevisionProposals.orgId, orgId),
          eq(schema.draftRevisionProposals.contentItemId, contentItemId),
        ),
      )
      .limit(1);
    return proposal ?? null;
  }

  private async stagedAdaptationProposals(
    orgId: string,
    contentItemId: string,
  ): Promise<AdaptationProposal[]> {
    return db
      .select(ADAPTATION_PROPOSAL_COLUMNS)
      .from(schema.adaptationProposals)
      .where(
        and(
          eq(schema.adaptationProposals.orgId, orgId),
          eq(schema.adaptationProposals.contentItemId, contentItemId),
        ),
      );
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
  private async requireEditableItem(
    tx: Tx,
    orgId: string,
    id: string,
  ): Promise<{
    body: string;
    status: ContentStatus;
    richBody: unknown;
    bodyRevision: number;
    coverMediaId: string | null;
    videoMediaId: string | null;
  }> {
    const rows = await tx
      .select({
        status: schema.contentItems.status,
        body: schema.contentItems.body,
        richBody: schema.contentItems.richBody,
        bodyRevision: schema.contentItems.bodyRevision,
        coverMediaId: schema.contentItems.coverMediaId,
        videoMediaId: schema.contentItems.videoMediaId,
      })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .limit(1)
      .for("update");
    const item = rows[0];
    if (!item) throw notFound("content_not_found", "Content item not found");
    const pinned = pinnedItemRefusal(item.status);
    if (pinned) throw pinned;
    // Keep the reviewed text stable while a confirmed Telegram photo is live
    // and its reply still needs a human verdict. This also covers a channel
    // that inherits the item body rather than storing its own override.
    const partial = await tx
      .select({ id: schema.adaptations.id })
      .from(schema.adaptations)
      .where(
        and(
          eq(schema.adaptations.orgId, orgId),
          eq(schema.adaptations.contentItemId, id),
          eq(ADAPTATION_COLUMNS.deliveryOutcome, "partial"),
        ),
      )
      .limit(1);
    if (partial.length > 0) {
      throw conflict(
        "partial_telegram_unresolved",
        "Resolve the partial Telegram post before editing its reviewed text",
      );
    }
    return item;
  }

  /** A channel without an override publishes the master's reviewed text. */
  private async requireInheritedTelegramText(
    tx: Tx,
    orgId: string,
    itemId: string,
    body: string,
    covered: boolean,
    video: boolean,
  ): Promise<void> {
    const [inherited] = await tx
      .select({ id: schema.adaptations.id })
      .from(schema.adaptations)
      .innerJoin(schema.channels, eq(schema.channels.id, schema.adaptations.channelId))
      .where(
        and(
          eq(schema.adaptations.orgId, orgId),
          eq(schema.adaptations.contentItemId, itemId),
          eq(schema.channels.orgId, orgId),
          eq(schema.channels.platform, "telegram"),
          isNull(schema.adaptations.body),
        ),
      )
      .limit(1);
    if (!inherited) return;
    const problem = telegramTextProblem(body, covered, video);
    if (problem) throw badRequest("invalid_request", problem);
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
      richBody?: unknown;
      hashtags?: string[];
      cta?: string | null;
      createdBy: string;
    },
  ): Promise<void> {
    await tx.insert(schema.contentVersions).values({ ...row, origin: "human", scope: "full" });
  }

  async update(orgId: string, id: string, data: ContentUpdate, userId: string) {
    await db.transaction(async (tx) => {
      const current = await this.requireEditableItem(tx, orgId, id);
      if (
        data.richBody !== undefined &&
        (data.expectedBody !== current.body || data.expectedBodyRevision !== current.bodyRevision)
      ) {
        throw bodyRevisionConflict(current.bodyRevision);
      }
      if (data.body !== undefined && data.body !== current.body) {
        await this.requireInheritedTelegramText(
          tx,
          orgId,
          id,
          data.body,
          current.coverMediaId !== null,
          current.videoMediaId !== null,
        );
        await assertImagesFitBody(tx, orgId, id, data.body);
      }
      await tx
        .update(schema.contentItems)
        .set({ title: data.title, body: data.body, richBody: data.richBody })
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)));
      const versionBody = humanVersionBody(current.body, data.body);
      const richChanged =
        data.richBody !== undefined &&
        JSON.stringify(current.richBody) !== JSON.stringify(data.richBody);
      if (versionBody !== null || richChanged) {
        await this.recordHumanVersion(tx, {
          orgId,
          contentItemId: id,
          adaptationId: null,
          body: data.body ?? current.body,
          richBody: data.richBody === undefined ? null : data.richBody,
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
    /**
     * THE BODY IN ITS CANONICAL FORM, and the same string for all three of the
     * things this route does with it: the selection it slices, the text the
     * model is shown, and the length it bounds the merge by.
     *
     * `content_items.body` is canonical only for bodies written through the
     * DTO. The worker's terminal write stores the model's reply, and the
     * writer/editor output schemas normalise it there — belt; this is the
     * braces, for a row that reached the table by some other road (a restored
     * dump, a migration, a future writer).
     *
     * The reason it must be THIS string is the client, not tidiness: the shipped
     * editor renders `normalizeNewlines(value)` and reports its offsets against
     * that, and a `<textarea>` drops CR from its value regardless. Offsets from
     * a CR-free string applied to a CR-bearing one select the wrong words —
     * silently, since the canonical body is the SHORTER one, so the
     * past-the-end refusal can never fire. The reader pays for a refine of text
     * they did not select, and Accept (which normalises) then cannot find the
     * anchor it was given.
     */
    const body = normalizeNewlines(item.body);
    const selection = selectionOf(body, request);
    await this.requireAiDraft(orgId, id);
    if (await this.overEditorAiBudget(orgId)) {
      throw conflict(
        "refine_limit_reached",
        `This organization has already made ${MAX_REFINE_CALLS_PER_HOUR} editor AI calls in the last hour`,
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
        before: body.slice(0, request.start),
        after: body.slice(request.end),
      },
    });

    // BEFORE the verdict, and for the failed verdict too: the provider counts
    // tokens before it knows whether we could parse the answer, so a refine
    // that ends in a 409 can still have cost money. A ledger that recorded only
    // the answers we liked would understate the org's spend AND hand this
    // route's own allowance a count that misses the calls most worth counting.
    await this.recordEditorUsage(orgId, id, outcome.usage);
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
     * Measured the way Accept measures it, on BOTH sides of the splice:
     * `normalizeNewlines` first (the DTO's own rule — the limit bounds what
     * gets STORED, and a model's CRLF is a character the product is about to
     * drop), the splice second, into the canonical `body` above rather than the
     * raw row. Accept checks
     * again rather than trusting this one, because the body can grow between
     * propose and accept; this is the first line of defence and that is the
     * second.
     */
    const proposal = normalizeNewlines(outcome.text);
    const merged = body.slice(0, request.start) + proposal + body.slice(request.end);
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

  /** Spend one bounded editor call, then stage a whole-body rewrite for explicit acceptance. */
  async reviseDraft(orgId: string, id: string, userId: string, request: DraftRevisionRequest) {
    const item = await this.refinableItem(orgId, id);
    if (item.status === "partially_published") {
      throw conflict(
        "content_partially_published",
        "A post already live on a channel cannot be rewritten as a draft",
      );
    }
    const sourceBody = normalizeNewlines(item.body);
    if (sourceBody !== request.expectedBody) {
      throw conflict("draft_revision_stale", "This draft changed; reload before revising it");
    }
    await this.requireAiDraft(orgId, id, "draft_revision");
    let instruction = request.instruction;
    if (request.noteId) {
      const [note] = await db
        .select({ note: schema.editorialNotes.note, bodyHash: schema.editorialNotes.bodyHash })
        .from(schema.editorialNotes)
        .where(
          and(
            eq(schema.editorialNotes.orgId, orgId),
            eq(schema.editorialNotes.contentItemId, id),
            eq(schema.editorialNotes.id, request.noteId),
          ),
        )
        .limit(1);
      if (!note) throw notFound("draft_revision_note_not_found", "Editorial note not found");
      if (note.bodyHash !== createHash("sha256").update(item.body).digest("hex")) {
        throw conflict("draft_revision_stale", "That note belongs to an earlier saved draft");
      }
      instruction = note.note;
    }
    if (!instruction) throw new Error("Draft revision instruction was not resolved");
    if (await this.overEditorAiBudget(orgId)) {
      throw conflict(
        "draft_revision_limit_reached",
        "This organization's editor AI allowance is spent",
      );
    }
    const credential = await this.refineCredential(orgId, "draft_revision");
    const outcome = await this.draftReviser.run({
      credential,
      brand: await this.brandFor(orgId, item.brandId),
      body: sourceBody,
      instruction,
    });
    await this.recordEditorUsage(orgId, id, outcome.usage);
    if (!outcome.ok) {
      throw conflict(
        outcome.failure === "timed_out" ? "draft_revision_timed_out" : "draft_revision_failed",
        "The model could not revise this draft; nothing was changed",
      );
    }
    const proposal = normalizeNewlines(outcome.text);
    return db.transaction(async (tx) => {
      const [existing] = await tx
        .select({ id: schema.contentItems.id, status: schema.contentItems.status })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
        .limit(1)
        .for("update");
      if (!existing) throw notFound("content_not_found", "Content item not found");
      if (existing.status === "archived") {
        throw conflict("content_archived", "Restore this archived content before changing it");
      }
      await tx
        .delete(schema.draftRevisionProposals)
        .where(eq(schema.draftRevisionProposals.contentItemId, id));
      const [staged] = await tx
        .insert(schema.draftRevisionProposals)
        .values({
          orgId,
          contentItemId: id,
          sourceBody,
          instruction,
          proposal,
          reason: outcome.reason,
          createdBy: userId,
        })
        .returning(DRAFT_REVISION_COLUMNS);
      if (!staged) throw new Error("Draft revision proposal was not staged");
      return staged;
    });
  }

  async acceptDraftRevision(orgId: string, id: string, proposalId: string) {
    await db.transaction(async (tx) => {
      const item = await this.requireEditableItem(tx, orgId, id);
      if (item.status === "partially_published") {
        throw conflict(
          "content_partially_published",
          "A post already live on a channel cannot be rewritten as a draft",
        );
      }
      const [proposal] = await tx
        .select(DRAFT_REVISION_COLUMNS)
        .from(schema.draftRevisionProposals)
        .where(
          and(
            eq(schema.draftRevisionProposals.orgId, orgId),
            eq(schema.draftRevisionProposals.contentItemId, id),
            eq(schema.draftRevisionProposals.id, proposalId),
          ),
        )
        .limit(1)
        .for("update");
      if (!proposal)
        throw notFound("draft_revision_proposal_not_found", "That rewrite is no longer staged");
      if (normalizeNewlines(item.body) !== proposal.sourceBody) {
        throw conflict(
          "draft_revision_stale",
          "The saved draft changed; discard this rewrite and try again",
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
        body: proposal.sourceBody,
        start: 0,
        end: proposal.sourceBody.length,
        proposal: proposal.proposal,
        aiRows,
      });
      if (!plan.ok) {
        const refusal = REFINE_PLAN_REFUSAL[plan.reason];
        throw conflict(refusal.code, refusal.message);
      }
      if (!("unchanged" in plan)) {
        await assertImagesFitBody(tx, orgId, id, plan.mergedBody);
        await tx
          .update(schema.contentItems)
          .set({ body: plan.mergedBody, status: "draft" })
          .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)));
        await tx.insert(schema.contentVersions).values({
          orgId,
          contentItemId: id,
          adaptationId: null,
          body: plan.fragmentBody,
          origin: "ai",
          scope: "fragment",
          unitDelta: plan.unitDelta,
          createdBy: null,
        });
        await tx.delete(schema.refineProposals).where(eq(schema.refineProposals.contentItemId, id));
      }
      await tx
        .delete(schema.draftRevisionProposals)
        .where(eq(schema.draftRevisionProposals.id, proposal.id));
    });
    return this.get(orgId, id);
  }

  async discardDraftRevision(orgId: string, id: string, proposalId: string): Promise<void> {
    const deleted = await db
      .delete(schema.draftRevisionProposals)
      .where(
        and(
          eq(schema.draftRevisionProposals.orgId, orgId),
          eq(schema.draftRevisionProposals.contentItemId, id),
          eq(schema.draftRevisionProposals.id, proposalId),
        ),
      )
      .returning({ id: schema.draftRevisionProposals.id });
    if (deleted.length === 0)
      throw notFound("draft_revision_proposal_not_found", "That rewrite is no longer staged");
  }

  /** Return the single staged correction, including its source body for a visible diff. */
  async claimCorrection(orgId: string, id: string): Promise<ClaimCorrectionProposalDto | null> {
    const [item] = await db
      .select({ id: schema.contentItems.id })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .limit(1);
    if (!item) throw notFound("content_not_found", "Post not found");
    const [row] = await db
      .select(CLAIM_CORRECTION_COLUMNS)
      .from(schema.claimCorrectionProposals)
      .where(
        and(
          eq(schema.claimCorrectionProposals.orgId, orgId),
          eq(schema.claimCorrectionProposals.contentItemId, id),
        ),
      )
      .limit(1);
    return row ? claimCorrectionDto(row) : null;
  }

  /** Newest accepted corrections first; a receipt ID is an opaque item-scoped cursor. */
  async acceptedClaimCorrections(
    orgId: string,
    id: string,
    cursor?: string,
  ): Promise<AcceptedClaimCorrectionListDto> {
    const [item] = await db
      .select({ id: schema.contentItems.id })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .limit(1);
    if (!item) throw notFound("content_not_found", "Post not found");
    const [before] = cursor
      ? await db
          .select({ id: schema.acceptedClaimCorrections.id })
          .from(schema.acceptedClaimCorrections)
          .where(
            and(
              eq(schema.acceptedClaimCorrections.orgId, orgId),
              eq(schema.acceptedClaimCorrections.contentItemId, id),
              eq(schema.acceptedClaimCorrections.id, cursor),
            ),
          )
          .limit(1)
      : [undefined];
    if (cursor && !before) throw badRequest("invalid_request", "Unknown correction cursor");
    const page = await db
      .select(ACCEPTED_CORRECTION_COLUMNS)
      .from(schema.acceptedClaimCorrections)
      .where(
        and(
          eq(schema.acceptedClaimCorrections.orgId, orgId),
          eq(schema.acceptedClaimCorrections.contentItemId, id),
          before
            ? sql<boolean>`(${schema.acceptedClaimCorrections.acceptedAt}, ${schema.acceptedClaimCorrections.id}) < (
          SELECT cursor_receipt.accepted_at, cursor_receipt.id
          FROM accepted_claim_corrections AS cursor_receipt
          WHERE cursor_receipt.id = ${before.id}
            AND cursor_receipt.org_id = ${orgId}
            AND cursor_receipt.content_item_id = ${id}
        )`
            : undefined,
        ),
      )
      .orderBy(
        desc(schema.acceptedClaimCorrections.acceptedAt),
        desc(schema.acceptedClaimCorrections.id),
      )
      .limit(21);
    return {
      rows: page.slice(0, 20).map(acceptedCorrectionDto),
      nextCursor: page.length > 20 ? (page[19]?.id ?? null) : null,
    };
  }

  /** Spend only after the exact saved body and an evidence conflict qualify. */
  async proposeClaimCorrection(
    orgId: string,
    id: string,
    request: ClaimCorrectionRequest,
  ): Promise<ClaimCorrectionProposalDto> {
    const item = await this.refinableItem(orgId, id);
    if (item.status === "partially_published" || item.body !== request.expectedBody) {
      throw conflict(
        "claim_correction_stale",
        "This draft changed or has already been published; reload it before proposing a correction",
      );
    }
    const [review] = await db
      .select({
        id: schema.claimReviews.id,
        bodyHash: schema.claimReviews.bodyHash,
        status: schema.claimReviews.status,
        claims: schema.claimReviews.claims,
      })
      .from(schema.claimReviews)
      .where(and(eq(schema.claimReviews.orgId, orgId), eq(schema.claimReviews.contentItemId, id)))
      .orderBy(desc(schema.claimReviews.createdAt), desc(schema.claimReviews.id))
      .limit(1);
    const hash = createHash("sha256").update(item.body, "utf8").digest("hex");
    if (review?.id !== request.reviewId || review.status !== "ready" || review.bodyHash !== hash) {
      throw conflict(
        "claim_correction_stale",
        "This evidence review is no longer ready for the saved draft",
      );
    }
    const selected = review.claims[request.claimIndex];
    if (
      selected?.outcome !== "evidence_conflicts" ||
      selected.claim.length === 0 ||
      selected.claim.length > 1_000 ||
      !selected.evidence.some(
        (entry) => entry.snippet.trim().length > 0 && entry.url.length <= 2_048,
      )
    ) {
      throw conflict(
        "claim_correction_ineligible",
        "Select a conflicting claim with cited search evidence",
      );
    }
    const start = item.body.indexOf(selected.claim);
    if (start < 0 || item.body.indexOf(selected.claim, start + 1) !== -1) {
      throw conflict(
        "claim_correction_ineligible",
        "The exact claim must occur once in the saved draft",
      );
    }
    const aiRows = await db
      .select({ body: schema.contentVersions.body, scope: schema.contentVersions.scope })
      .from(schema.contentVersions)
      .where(
        and(
          eq(schema.contentVersions.orgId, orgId),
          eq(schema.contentVersions.contentItemId, id),
          isNull(schema.contentVersions.adaptationId),
          eq(schema.contentVersions.origin, "ai"),
        ),
      );
    if (!aiRows.some((row) => row.scope === "full"))
      throw conflict("claim_correction_ineligible", "AI corrections require a generated draft");
    // A sentinel probes the same provenance rule Accept uses. It catches the
    // impossible case where replacing only this quote would absorb human text
    // that sits outside the quote. The actual model reply is checked again at
    // Accept, since its sentence boundaries and duplicate text can differ.
    const sentinel = `Correction ${hash.slice(0, 16)}.`;
    const preflight = planRefineAccept({
      body: item.body,
      start,
      end: start + selected.claim.length,
      proposal: sentinel,
      aiRows,
    });
    if (!preflight.ok && preflight.reason === "would_launder") {
      throw conflict(
        "claim_correction_ineligible",
        "Select the entire human-authored sentence before requesting an AI correction",
      );
    }
    if (await this.overEditorAiBudget(orgId)) {
      throw conflict(
        "claim_correction_limit_reached",
        "This organization's hourly editor AI allowance is spent",
      );
    }
    const credential = await this.refineCredential(orgId, "claim_correction");
    const evidence = selected.evidence
      .filter((entry) => entry.snippet.trim().length > 0 && entry.url.length <= 2_048)
      .slice(0, 3);
    if (evidence.length === 0)
      throw conflict("claim_correction_ineligible", "No usable citation remains for this claim");
    const outcome = await this.claimCorrector.run({
      credential,
      brand: await this.brandFor(orgId, item.brandId),
      input: {
        claim: selected.claim,
        before: item.body.slice(Math.max(0, start - 1_000), start),
        after: item.body.slice(
          start + selected.claim.length,
          start + selected.claim.length + 1_000,
        ),
        evidence: evidence.map((entry) => ({
          title: entry.title.slice(0, 200),
          url: entry.url,
          snippet: entry.snippet.slice(0, 500),
        })),
      },
    });
    await this.recordEditorUsage(orgId, id, outcome.usage);
    if (!outcome.ok) {
      throw conflict(
        outcome.failure === "timed_out" ? "claim_correction_timed_out" : "claim_correction_failed",
        "The model could not propose a correction; the draft was not changed",
      );
    }
    const replacement = normalizeNewlines(outcome.replacement);
    if (replacement.trim().length === 0 || outcome.reason.trim().length === 0) {
      throw conflict(
        "claim_correction_failed",
        "The model returned an empty correction; the draft was not changed",
      );
    }
    if (
      replacement === selected.claim ||
      item.body.length - selected.claim.length + replacement.length > MAX_BODY_LENGTH
    ) {
      throw conflict(
        "claim_correction_ineligible",
        "The suggested correction cannot be applied to this draft",
      );
    }
    return db.transaction(async (tx) => {
      const current = await this.requireEditableItem(tx, orgId, id);
      if (current.body !== request.expectedBody || current.status === "partially_published") {
        throw conflict(
          "claim_correction_stale",
          "The draft changed while the model was answering; review it again",
        );
      }
      const [currentReview] = await tx
        .select({
          id: schema.claimReviews.id,
          bodyHash: schema.claimReviews.bodyHash,
          status: schema.claimReviews.status,
          claims: schema.claimReviews.claims,
        })
        .from(schema.claimReviews)
        .where(and(eq(schema.claimReviews.orgId, orgId), eq(schema.claimReviews.contentItemId, id)))
        .orderBy(desc(schema.claimReviews.createdAt), desc(schema.claimReviews.id))
        .for("share")
        .limit(1);
      if (
        currentReview?.id !== request.reviewId ||
        currentReview.status !== "ready" ||
        currentReview.bodyHash !== hash ||
        JSON.stringify(currentReview.claims[request.claimIndex]) !== JSON.stringify(selected)
      ) {
        throw conflict(
          "claim_correction_stale",
          "The evidence review changed while the model was answering",
        );
      }
      await tx
        .delete(schema.claimCorrectionProposals)
        .where(
          and(
            eq(schema.claimCorrectionProposals.orgId, orgId),
            eq(schema.claimCorrectionProposals.contentItemId, id),
          ),
        );
      const [row] = await tx
        .insert(schema.claimCorrectionProposals)
        .values({
          orgId,
          contentItemId: id,
          reviewId: request.reviewId,
          claimIndex: request.claimIndex,
          sourceBody: item.body,
          sourceBodyHash: hash,
          claim: selected.claim,
          replacement,
          reason: outcome.reason,
          evidence,
        })
        .returning(CLAIM_CORRECTION_COLUMNS);
      if (!row) throw new Error("Claim correction proposal was not staged");
      return claimCorrectionDto(row);
    });
  }

  /** Accept one exact source quote under the item's write lock. */
  async acceptClaimCorrection(orgId: string, id: string, proposalId: string) {
    await db.transaction(async (tx) => {
      const item = await this.requireEditableItem(tx, orgId, id);
      if (item.status === "partially_published") {
        throw conflict(
          "claim_correction_stale",
          "This post has already been published to a channel",
        );
      }
      const [proposal] = await tx
        .select(CLAIM_CORRECTION_COLUMNS)
        .from(schema.claimCorrectionProposals)
        .where(
          and(
            eq(schema.claimCorrectionProposals.orgId, orgId),
            eq(schema.claimCorrectionProposals.contentItemId, id),
            eq(schema.claimCorrectionProposals.id, proposalId),
          ),
        )
        .for("update")
        .limit(1);
      if (!proposal)
        throw notFound("claim_correction_not_found", "That correction is no longer staged");
      if (
        item.body !== proposal.sourceBody ||
        createHash("sha256").update(item.body, "utf8").digest("hex") !== proposal.sourceBodyHash
      ) {
        throw conflict(
          "claim_correction_stale",
          "The saved draft changed; discard this correction and check again",
        );
      }
      const [review] = await tx
        .select({
          id: schema.claimReviews.id,
          bodyHash: schema.claimReviews.bodyHash,
          status: schema.claimReviews.status,
          claims: schema.claimReviews.claims,
        })
        .from(schema.claimReviews)
        .where(and(eq(schema.claimReviews.orgId, orgId), eq(schema.claimReviews.contentItemId, id)))
        .orderBy(desc(schema.claimReviews.createdAt), desc(schema.claimReviews.id))
        .limit(1);
      const claim = review?.claims[proposal.claimIndex];
      if (
        review?.id !== proposal.reviewId ||
        review.status !== "ready" ||
        review.bodyHash !== proposal.sourceBodyHash ||
        !claim ||
        claim.outcome !== "evidence_conflicts" ||
        claim.claim !== proposal.claim
      ) {
        throw conflict(
          "claim_correction_stale",
          "The evidence review changed; check this draft again",
        );
      }
      const start = item.body.indexOf(proposal.claim);
      if (start < 0 || item.body.indexOf(proposal.claim, start + 1) !== -1) {
        throw conflict(
          "claim_correction_stale",
          "The source claim is no longer unique in this draft",
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
        body: item.body,
        start,
        end: start + proposal.claim.length,
        proposal: proposal.replacement,
        aiRows,
      });
      if (!plan.ok || "unchanged" in plan) {
        throw conflict(
          "claim_correction_ineligible",
          "This correction cannot be applied to the saved draft",
        );
      }
      await assertImagesFitBody(tx, orgId, id, plan.mergedBody);
      await tx
        .update(schema.contentItems)
        .set({
          body: plan.mergedBody,
          richBody: null,
          status: "draft",
        })
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)));
      const [fragment] = await tx
        .insert(schema.contentVersions)
        .values({
          orgId,
          contentItemId: id,
          adaptationId: null,
          body: plan.fragmentBody,
          origin: "ai",
          scope: "fragment",
          unitDelta: plan.unitDelta,
          createdBy: null,
        })
        .returning({ id: schema.contentVersions.id });
      if (!fragment) throw new Error("Claim correction fragment was not recorded");
      await tx.insert(schema.acceptedClaimCorrections).values({
        orgId,
        contentItemId: id,
        reviewId: proposal.reviewId,
        fragmentVersionId: fragment.id,
        claimIndex: proposal.claimIndex,
        sourceBodyHash: proposal.sourceBodyHash,
        claim: proposal.claim,
        replacement: proposal.replacement,
        reason: proposal.reason,
        evidence: proposal.evidence,
      });
      await tx
        .delete(schema.claimCorrectionProposals)
        .where(eq(schema.claimCorrectionProposals.id, proposal.id));
      await tx.delete(schema.refineProposals).where(eq(schema.refineProposals.contentItemId, id));
      await tx
        .delete(schema.draftRevisionProposals)
        .where(eq(schema.draftRevisionProposals.contentItemId, id));
    });
    return this.get(orgId, id);
  }

  async discardClaimCorrection(orgId: string, id: string, proposalId: string): Promise<void> {
    const deleted = await db
      .delete(schema.claimCorrectionProposals)
      .where(
        and(
          eq(schema.claimCorrectionProposals.orgId, orgId),
          eq(schema.claimCorrectionProposals.contentItemId, id),
          eq(schema.claimCorrectionProposals.id, proposalId),
        ),
      )
      .returning({ id: schema.claimCorrectionProposals.id });
    if (deleted.length === 0)
      throw notFound("claim_correction_not_found", "That correction is no longer staged");
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
  ): Promise<{ body: string; brandId: string; status: ContentStatus }> {
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
    return { body: item.body, brandId: item.brandId, status: item.status };
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
  private async requireAiDraft(
    orgId: string,
    id: string,
    action: "refine" | "draft_revision" = "refine",
  ): Promise<void> {
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
        action === "refine" ? "refine_needs_ai_draft" : "draft_revision_needs_ai_draft",
        "This post was written by hand; AI revision requires a generated draft",
      );
    }
  }

  /**
   * Has this org used up its hourly allowance of billed editor AI calls?
   *
   * The editor shares one allowance between selection refinement and channel
   * adaptation. Credential tests and generation runs have their own budgets.
   * `REFINE_STEP` is imported so its ledger name and this filter cannot drift.
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
  private async overEditorAiBudget(orgId: string): Promise<boolean> {
    const rows = await db
      .select({ calls: sql<string>`count(*)` })
      .from(schema.usageLedger)
      .where(
        and(
          eq(schema.usageLedger.orgId, orgId),
          inArray(schema.usageLedger.step, [
            REFINE_STEP,
            "readapt",
            DRAFT_REVISION_STEP,
            CLAIM_CORRECTION_STEP,
          ]),
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
  private async refineCredential(
    orgId: string,
    action: "refine" | "readapt" | "draft_revision" | "claim_correction" = "refine",
  ): Promise<AiCredential> {
    let credential: AiCredential | undefined;
    try {
      credential = await this.credentials.credential(orgId);
    } catch (error) {
      if (!isUnreadableCiphertext(error) && !isMalformedStoredAiCredential(error)) throw error;
      this.logger.error(
        `Editor AI call for org ${orgId} could not read the stored API key: ` +
          `${error instanceof Error ? error.message : String(error)}. ` +
          "Test the key in Settings for a verdict about it.",
      );
      throw conflict(
        action === "refine"
          ? "refine_failed"
          : action === "readapt"
            ? "readapt_failed"
            : action === "draft_revision"
              ? "draft_revision_failed"
              : "claim_correction_failed",
        REFINE_FAILURE_MESSAGE.failed,
      );
    }
    if (!credential) {
      throw conflict(
        action === "refine"
          ? "refine_no_credential"
          : action === "readapt"
            ? "readapt_no_credential"
            : action === "draft_revision"
              ? "draft_revision_no_credential"
              : "claim_correction_no_credential",
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
   * Editor calls have no run but do have a content item. Channel adaptation
   * additionally sets `adaptation_id`; master refinement leaves it null.
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
  private async recordEditorUsage(
    orgId: string,
    contentItemId: string,
    usage: readonly RefineUsage[],
    adaptationId: string | null = null,
  ): Promise<void> {
    if (usage.length === 0) return;
    const rows = usage.map(({ record, attribution }) => ({
      orgId,
      runId: null,
      step: attribution.step,
      channelId: attribution.channelId ?? null,
      contentItemId,
      adaptationId,
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
          `Content item ${contentItemId} disappeared before its ${usage[0]?.attribution.step} ledger row(s) ` +
            `could be written; recording the spend with content_item_id=null. orgId=${orgId}`,
        );
        try {
          await db
            .insert(schema.usageLedger)
            .values(rows.map((row) => ({ ...row, contentItemId: null, adaptationId: null })));
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
          `this org's spend is understated by them, and its editor AI allowance will not count them. ` +
          `orgId=${orgId} contentItemId=${contentItemId} step=${usage[0]?.attribution.step} ` +
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
      const [item] = await tx
        .select({ status: schema.contentItems.status })
        .from(schema.contentItems)
        .where(
          and(
            eq(schema.contentItems.orgId, row.orgId),
            eq(schema.contentItems.id, row.contentItemId),
          ),
        )
        .limit(1)
        .for("no key update");
      if (item?.status === "archived") {
        throw conflict("content_archived", "Restore this archived content before changing it");
      }
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
        await assertImagesFitBody(tx, orgId, id, plan.mergedBody);
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

  /** Spend one bounded model call, then stage its answer without changing publishable text. */
  async readapt(
    orgId: string,
    itemId: string,
    adaptationId: string,
    userId: string,
  ): Promise<AdaptationProposal> {
    const item = await this.refinableItem(orgId, itemId);
    const [adaptation] = await db
      .select({
        id: schema.adaptations.id,
        status: schema.adaptations.status,
        body: schema.adaptations.body,
        channelId: schema.adaptations.channelId,
      })
      .from(schema.adaptations)
      .where(
        and(
          eq(schema.adaptations.orgId, orgId),
          eq(schema.adaptations.contentItemId, itemId),
          eq(schema.adaptations.id, adaptationId),
        ),
      )
      .limit(1);
    if (!adaptation) throw notFound("adaptation_not_found", "Adaptation not found");
    if (!isEditableAdaptationStatus(adaptation.status)) {
      throw conflict(
        PINNED_ADAPTATION_CODE[adaptation.status],
        PINNED_ADAPTATION_MESSAGE[adaptation.status],
      );
    }
    const [channel] = await db
      .select({
        id: schema.channels.id,
        name: schema.channels.name,
        platform: schema.channels.platform,
      })
      .from(schema.channels)
      .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, adaptation.channelId)))
      .limit(1);
    if (!channel) throw notFound("channel_not_found", "Channel not found");
    if (await this.overEditorAiBudget(orgId)) {
      throw conflict(
        "readapt_limit_reached",
        `This organization has already made ${MAX_REFINE_CALLS_PER_HOUR} editor AI calls in the last hour`,
      );
    }
    const credential = await this.refineCredential(orgId, "readapt");
    const outcome = await this.readapter.run({
      credential,
      brand: await this.brandFor(orgId, item.brandId),
      channel: channel as StepChannel,
      masterBody: normalizeNewlines(item.body),
      previousBody: adaptation.body === null ? null : normalizeNewlines(adaptation.body),
    });
    await this.recordEditorUsage(orgId, itemId, outcome.usage, adaptationId);
    if (!outcome.ok) {
      throw conflict(
        outcome.failure === "timed_out" ? "readapt_timed_out" : "readapt_failed",
        "The model could not adapt this channel; nothing was changed",
      );
    }
    const row = {
      orgId,
      contentItemId: itemId,
      adaptationId,
      createdBy: userId,
      masterBody: normalizeNewlines(item.body),
      previousBody: adaptation.body === null ? null : normalizeNewlines(adaptation.body),
      proposal: normalizeNewlines(outcome.text),
      reason: outcome.reason,
    };
    return db.transaction(async (tx) => {
      // The adaptation precedes the item everywhere in this repository.
      const [locked] = await tx
        .select({ id: schema.adaptations.id })
        .from(schema.adaptations)
        .where(
          and(
            eq(schema.adaptations.orgId, orgId),
            eq(schema.adaptations.contentItemId, itemId),
            eq(schema.adaptations.id, adaptationId),
          ),
        )
        .limit(1)
        .for("no key update");
      if (!locked) throw notFound("adaptation_not_found", "Adaptation not found");
      const [parent] = await tx
        .select({ status: schema.contentItems.status })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, itemId)))
        .limit(1)
        .for("no key update");
      if (!parent) throw notFound("content_not_found", "Content item not found");
      if (parent.status === "archived") {
        throw conflict("content_archived", "Restore this archived content before changing it");
      }
      await tx
        .delete(schema.adaptationProposals)
        .where(eq(schema.adaptationProposals.adaptationId, adaptationId));
      const [staged] = await tx
        .insert(schema.adaptationProposals)
        .values(row)
        .returning(ADAPTATION_PROPOSAL_COLUMNS);
      if (!staged) throw new Error("adaptation proposal was not staged");
      return staged;
    });
  }

  async acceptReadapt(orgId: string, itemId: string, adaptationId: string, proposalId: string) {
    await db.transaction(async (tx) => {
      const [adaptation] = await tx
        .select({
          status: schema.adaptations.status,
          channelId: schema.adaptations.channelId,
          body: schema.adaptations.body,
          hashtags: schema.adaptations.hashtags,
          cta: schema.adaptations.cta,
        })
        .from(schema.adaptations)
        .where(
          and(
            eq(schema.adaptations.orgId, orgId),
            eq(schema.adaptations.contentItemId, itemId),
            eq(schema.adaptations.id, adaptationId),
          ),
        )
        .limit(1)
        .for("update");
      if (!adaptation) throw notFound("adaptation_not_found", "Adaptation not found");
      const item = await this.requireEditableItem(tx, orgId, itemId);
      if (!isEditableAdaptationStatus(adaptation.status)) {
        throw conflict(
          PINNED_ADAPTATION_CODE[adaptation.status],
          PINNED_ADAPTATION_MESSAGE[adaptation.status],
        );
      }
      const [proposal] = await tx
        .select(ADAPTATION_PROPOSAL_COLUMNS)
        .from(schema.adaptationProposals)
        .where(
          and(
            eq(schema.adaptationProposals.orgId, orgId),
            eq(schema.adaptationProposals.contentItemId, itemId),
            eq(schema.adaptationProposals.adaptationId, adaptationId),
            eq(schema.adaptationProposals.id, proposalId),
          ),
        )
        .limit(1)
        .for("update");
      if (!proposal) throw notFound("readapt_proposal_not_found", "Channel suggestion not found");
      if (
        normalizeNewlines(item.body) !== proposal.masterBody ||
        (adaptation.body === null ? null : normalizeNewlines(adaptation.body)) !==
          proposal.previousBody
      ) {
        throw conflict(
          "readapt_source_changed",
          "The source or channel text changed; ask for a new adaptation",
        );
      }
      // The model sees the previously composed channel body. If it carries
      // forward that exact managed final block, remove only that block before
      // composing again. Any different authored tag paragraph stays intact.
      const proposedText = stripHashtagSuffix(proposal.proposal, adaptation.hashtags);
      if (!proposedText.trim()) {
        throw badRequest("invalid_request", "Channel text must contain content before hashtags");
      }
      const proposedBody = withHashtags(proposedText, adaptation.hashtags);
      const [channel] = await tx
        .select({ platform: schema.channels.platform })
        .from(schema.channels)
        .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, adaptation.channelId)))
        .limit(1);
      if (!channel) throw notFound("channel_not_found", "Channel not found");
      const limit = adaptationLimit(channel.platform);
      if (limit === undefined) throw badRequest("invalid_request", "Unknown channel platform");
      if (proposedBody.length > limit) {
        throw badRequest(
          "invalid_request",
          `Channel text with hashtags exceeds ${limit} characters`,
        );
      }
      if (channel.platform === "telegram") {
        const problem = telegramTextProblem(
          proposedBody,
          item.coverMediaId !== null,
          item.videoMediaId !== null,
        );
        if (problem) throw badRequest("invalid_request", problem);
      }
      if (adaptation.body !== proposedBody) {
        await tx
          .update(schema.adaptations)
          .set({ body: proposedBody, origin: "ai" })
          .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptationId)));
        await tx.insert(schema.contentVersions).values({
          orgId,
          contentItemId: itemId,
          adaptationId,
          body: proposedBody,
          hashtags: adaptation.hashtags,
          cta: adaptation.cta,
          origin: "ai",
          scope: "full",
          createdBy: null,
        });
      }
      await tx
        .delete(schema.adaptationProposals)
        .where(eq(schema.adaptationProposals.id, proposalId));
    });
    return this.get(orgId, itemId);
  }

  async discardReadapt(
    orgId: string,
    itemId: string,
    adaptationId: string,
    proposalId: string,
  ): Promise<void> {
    const [deleted] = await db
      .delete(schema.adaptationProposals)
      .where(
        and(
          eq(schema.adaptationProposals.orgId, orgId),
          eq(schema.adaptationProposals.contentItemId, itemId),
          eq(schema.adaptationProposals.adaptationId, adaptationId),
          eq(schema.adaptationProposals.id, proposalId),
        ),
      )
      .returning({ id: schema.adaptationProposals.id });
    if (!deleted) throw notFound("readapt_proposal_not_found", "Channel suggestion not found");
  }

  /**
   * Same pin as `update`, one level down: an approved item's per-channel
   * override is the exact text that channel will receive, so it is frozen for
   * as long as a delivery is outstanding. A changed override leaves a version
   * row at the adaptation level, where restore will find it.
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
        .select({
          status: schema.adaptations.status,
          channelId: schema.adaptations.channelId,
          body: schema.adaptations.body,
          hashtags: schema.adaptations.hashtags,
          cta: schema.adaptations.cta,
        })
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

      const item = await this.requireEditableItem(tx, orgId, contentItemId);
      if (!isEditableAdaptationStatus(current.status)) {
        throw conflict(
          PINNED_ADAPTATION_CODE[current.status],
          PINNED_ADAPTATION_MESSAGE[current.status],
        );
      }

      if (
        (data.hashtags !== undefined &&
          JSON.stringify(current.hashtags) !== JSON.stringify(data.expectedHashtags)) ||
        (data.cta !== undefined && current.cta !== data.expectedCta)
      ) {
        throw conflict("version_changed", "This channel's details changed; reload before saving");
      }
      const bodySource = data.body === undefined ? current.body : data.body;
      const hashtags =
        bodySource === null
          ? []
          : data.hashtags === undefined
            ? current.hashtags
            : normalizeHashtags(data.hashtags);
      const cta = bodySource === null ? null : data.cta === undefined ? current.cta : data.cta;
      const nextBody =
        bodySource === null
          ? null
          : data.body === undefined
            ? replaceHashtags(bodySource, current.hashtags, hashtags)
            : withHashtags(bodySource, hashtags);
      const [channel] = await tx
        .select({ platform: schema.channels.platform })
        .from(schema.channels)
        .where(and(eq(schema.channels.orgId, orgId), eq(schema.channels.id, current.channelId)))
        .limit(1);
      if (!channel) throw notFound("channel_not_found", "Channel not found");
      const limit = adaptationLimit(channel.platform);
      if (limit === undefined) throw badRequest("invalid_request", "Unknown channel platform");
      if (nextBody !== null && nextBody.length > limit) {
        throw badRequest(
          "invalid_request",
          `Channel text with hashtags exceeds ${limit} characters`,
        );
      }
      if (channel.platform === "telegram" && nextBody !== null) {
        const problem = telegramTextProblem(
          nextBody,
          item.coverMediaId !== null,
          item.videoMediaId !== null,
        );
        if (problem) throw badRequest("invalid_request", problem);
      }
      if (!nextBody?.trim() && (hashtags.length > 0 || cta)) {
        throw badRequest("invalid_request", "Hashtags and calls to action require channel text");
      }
      const rows = await tx
        .update(schema.adaptations)
        .set({ body: nextBody, hashtags, cta })
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

      const versionBody = humanVersionBody(current.body, nextBody);
      if (
        nextBody !== null &&
        (versionBody !== null ||
          JSON.stringify(current.hashtags) !== JSON.stringify(hashtags) ||
          current.cta !== cta)
      ) {
        await this.recordHumanVersion(tx, {
          orgId,
          contentItemId,
          adaptationId,
          body: versionBody ?? nextBody ?? "",
          hashtags,
          cta,
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
   * **WHAT "PUBLISHED" MEANS HERE DEPENDS ON THE DOOR, and the two doors are
   * genuinely different acts.** `approve` asks about the ITEM: a
   * partly-delivered post has channels left to send and re-approving sends
   * exactly those (`approve` targets `pending`/`failed`/`scheduled`, so the
   * live one cannot be sent twice), which is the retry this product already
   * shipped unlabelled. `reject` asks whether ANY adaptation is `published`,
   * because rejecting is a one-way door: it writes `rejected`
   * (`setItemStatus`) over an item with a live post, and the only writer that
   * could ever bring it back is a delivery — of which this item has none left
   * outstanding. The item's own status cannot answer that question, which is
   * the whole of why the reach is a parameter: a `partially_published` item is
   * not `published`, and rejecting it is exactly as irreversible as rejecting
   * one that is.
   *
   * **AND IT REFUSES ONLY THE FAN-OUT THAT HAS ALREADY STOPPED.** The sentence
   * this gate hands the reader — "nothing will re-send it on its own, so
   * leaving it as it is stops it" — is true of `{published, failed}` and FALSE
   * of `{published, queued}`, where a pg-boss job is on its way to a channel
   * and reject was the only control in this product that could stop it
   * (`reject`'s cancel loop). Refusing both states told a person looking at a
   * live send that they need do nothing, and took away the one thing that
   * would have done it. So the refusal is scoped to `hasOutstanding === false`,
   * where the sentence is true as written; with something outstanding the
   * caller is told `true` and cancels it instead. What a person does INSTEAD,
   * to stop a fan-out this gate DOES refuse: nothing — nothing re-sends by
   * itself, so leaving the item where it is IS the stop.
   *
   * Returns whether a published adaptation exists, which is the fact `reject`
   * needs after it: an accepted reject that leaves a live post behind is not a
   * rejection and must not write `rejected`.
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
  private async requireNotPublished(
    tx: Tx,
    orgId: string,
    id: string,
    reach: Reach,
  ): Promise<boolean> {
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
    if (rows[0]?.status === "archived") {
      throw conflict("content_archived", "Restore this archived content before changing it");
    }
    if (reach.of === "the item") return false;
    // NO LOCK ON THE ADAPTATIONS, and no new one anywhere: `reject` has
    // already taken `lockAdaptations` over its own outstanding rows, and this
    // read asks about the rows that are `published` — terminal, with no job
    // behind them and no writer left that could move them inside this
    // transaction. `docs/lock-order.md` is unchanged by this task: the
    // acquisitions are `adaptations` then `content_items`, exactly as before.
    // The item's own status is still asked FIRST, and it is not redundant: an
    // item whose channels were all deleted after it published has no
    // `published` adaptation left to find, and it is a published item all the
    // same. The two clauses answer different questions and neither implies the
    // other.
    const live = await tx
      .select({ id: schema.adaptations.id })
      .from(schema.adaptations)
      .where(
        and(
          eq(schema.adaptations.orgId, orgId),
          eq(schema.adaptations.contentItemId, id),
          eq(schema.adaptations.status, "published"),
        ),
      )
      .limit(1);
    if (live.length === 0) return false;
    if (reach.hasOutstanding) return true;
    // ITS OWN CODE, not `content_already_published`. This item is not
    // published — it is `partially_published`, or about to be — and the older
    // code's sentence says both that the post "has already been published"
    // (beside a badge reading "Partly published") and that approve is refused,
    // when approve is the action that works here. See `errors.ts`.
    throw conflict(
      "content_partially_published",
      "This content has already been published to one of its channels; it can no longer be " +
        "rejected. Nothing will re-send it on its own, so leaving it as it is stops it",
    );
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

  /** The decision journal has an org FK. Take its implicit lock before item locks. */
  private async holdDecisionOrganization(tx: Tx, orgId: string): Promise<void> {
    await tx
      .select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.id, orgId))
      .for("key share");
  }

  /** Read only after the item lock: delivery status alone is not a new verdict. */
  private async shouldJournalDecision(
    tx: Tx,
    orgId: string,
    id: string,
    verdict: "approved" | "rejected",
    hasFailedTarget = false,
  ): Promise<{ should: boolean; ordinal: number }> {
    const [item] = await tx
      .select({ status: schema.contentItems.status })
      .from(schema.contentItems)
      .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
      .limit(1);
    const [last] = await tx
      .select({ verdict: schema.promptDecisions.verdict, ordinal: schema.promptDecisions.ordinal })
      .from(schema.promptDecisions)
      .where(
        and(eq(schema.promptDecisions.orgId, orgId), eq(schema.promptDecisions.contentItemId, id)),
      )
      .orderBy(desc(schema.promptDecisions.ordinal))
      .limit(1);
    const preStatus = item?.status;
    const should =
      verdict === "approved"
        ? // A failed delivery, an edited draft, or a partly published fan-out
          // can require a new human approval even after an earlier approval.
          preStatus === "draft" ||
          preStatus === "failed" ||
          preStatus === "rejected" ||
          preStatus === "partially_published" ||
          hasFailedTarget ||
          last?.verdict === "rejected"
        : // A re-opened draft can be rejected again, but a delivery's status
          // change alone never manufactures a second reject verdict.
          (preStatus !== "rejected" && preStatus !== "partially_published") ||
          last?.verdict === "approved";
    return { should, ordinal: (last?.ordinal ?? 0) + 1 };
  }

  /** Persist the observed human act without locking a run after the item. */
  private async appendPromptDecision(
    tx: Tx,
    orgId: string,
    id: string,
    verdict: "approved" | "rejected",
    ordinal: number,
  ): Promise<void> {
    const fullAiMasters = await tx
      .select({ runId: schema.contentVersions.runId })
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
      .orderBy(asc(schema.contentVersions.createdAt), asc(schema.contentVersions.id))
      .limit(2);
    let runId: string | null = null;
    let revisions: { role: PromptRole; revisionId: string; version: number }[] = [];
    let templateLinks: {
      role: PromptRole;
      revisionId: string | null;
      version: number | null;
      isDefault: boolean;
    }[] = [];
    // A second full AI master has no single trustworthy producing-run anchor.
    if (fullAiMasters.length === 1 && fullAiMasters[0]?.runId) {
      const [run] = await tx
        .select({
          id: schema.pipelineRuns.id,
          guidanceSnapshot: schema.pipelineRuns.guidanceSnapshot,
          templateSnapshot: schema.pipelineRuns.templateSnapshot,
        })
        .from(schema.pipelineRuns)
        .where(
          and(
            eq(schema.pipelineRuns.orgId, orgId),
            eq(schema.pipelineRuns.id, fullAiMasters[0].runId),
            eq(schema.pipelineRuns.contentItemId, id),
          ),
        )
        .limit(1);
      const snapshot = run?.guidanceSnapshot;
      if (snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)) {
        const entries = Object.entries(snapshot);
        const wellFormed = entries.every(
          ([role, value]) =>
            (PROMPT_ROLES as readonly string[]).includes(role) &&
            value !== null &&
            typeof value === "object" &&
            z.string().uuid().safeParse(value.revisionId).success &&
            Number.isInteger(value.version) &&
            value.version > 0,
        );
        if (wellFormed) {
          const candidates = entries.map(([role, value]) => ({
            role: role as PromptRole,
            revisionId: value.revisionId,
            version: value.version,
          }));
          const stored = candidates.length
            ? await tx
                .select({
                  id: schema.promptRevisions.id,
                  role: schema.promptRevisions.role,
                  version: schema.promptRevisions.version,
                })
                .from(schema.promptRevisions)
                .where(
                  and(
                    eq(schema.promptRevisions.orgId, orgId),
                    inArray(
                      schema.promptRevisions.id,
                      candidates.map((candidate) => candidate.revisionId),
                    ),
                  ),
                )
            : [];
          if (
            candidates.every((candidate) =>
              stored.some(
                (revision) =>
                  revision.id === candidate.revisionId &&
                  revision.role === candidate.role &&
                  revision.version === candidate.version,
              ),
            )
          ) {
            runId = run.id;
            revisions = candidates;
          }
        }
      }
      // Template evidence is independent of guidance: a corrupt snapshot in
      // either system cannot erase a verified attribution in the other.
      if (run?.templateSnapshot) {
        let pinned: TemplateSnapshot | null = null;
        try {
          pinned = validateTemplateSnapshot(run.templateSnapshot);
        } catch {
          // Invalid stored evidence earns no template links.
        }
        if (pinned) {
          const candidateLinks = PROMPT_ROLES.map((role) => {
            const selected = pinned.roles[role];
            return {
              role,
              revisionId: selected.revisionId,
              version: selected.version,
              isDefault: selected.kind === "default",
              sourceSha256: selected.sourceSha256,
            };
          });
          const selectedIds = candidateLinks.flatMap((link) =>
            link.revisionId ? [link.revisionId] : [],
          );
          const stored = selectedIds.length
            ? await tx
                .select({
                  id: schema.roleTemplateRevisions.id,
                  role: schema.roleTemplateRevisions.role,
                  version: schema.roleTemplateRevisions.version,
                  sourceSha256: schema.roleTemplateRevisions.sourceSha256,
                })
                .from(schema.roleTemplateRevisions)
                .where(
                  and(
                    eq(schema.roleTemplateRevisions.orgId, orgId),
                    inArray(schema.roleTemplateRevisions.id, selectedIds),
                  ),
                )
            : [];
          if (
            candidateLinks.every(
              (link) =>
                link.isDefault ||
                stored.some(
                  (revision) =>
                    revision.id === link.revisionId &&
                    revision.role === link.role &&
                    revision.version === link.version &&
                    revision.sourceSha256 === link.sourceSha256,
                ),
            )
          ) {
            templateLinks = candidateLinks.map(({ role, revisionId, version, isDefault }) => ({
              role,
              revisionId,
              version,
              isDefault,
            }));
            runId = run.id;
          }
        }
      }
    }
    const decidedAt = new Date();
    const [decision] = await tx
      .insert(schema.promptDecisions)
      .values({ orgId, contentItemId: id, runId, verdict, ordinal, createdAt: decidedAt })
      .returning({ id: schema.promptDecisions.id });
    if (decision && revisions.length) {
      await tx.insert(schema.promptDecisionRevisions).values(
        revisions.map((revision) => ({
          orgId,
          decisionId: decision.id,
          ...revision,
          decidedAt,
        })),
      );
    }
    if (decision && templateLinks.length) {
      await tx.insert(schema.promptDecisionTemplateRevisions).values(
        templateLinks.map((link) => ({
          orgId,
          decisionId: decision.id,
          ...link,
          decidedAt,
        })),
      );
    }
  }

  /**
   * Which of these adaptations had an attempt whose outcome nobody knows.
   *
   * The same expression the wire reports (`ADAPTATION_COLUMNS.deliveryOutcome`)
   * rather than a second reading of the receipts: the screen that warns a
   * person not to re-send and the code that refuses to re-send must not be able
   * to disagree about which row is in doubt.
   *
   * A separate statement, taken AFTER the caller's `lockAdaptations` and never
   * folded into it. Under READ COMMITTED a statement's snapshot is taken when
   * the statement starts, so a read fused into the locking SELECT would answer
   * from a snapshot older than whatever that lock waited for — the exact
   * staleness the lock was acquired to remove.
   */
  private async unknownDeliveries(tx: Tx, orgId: string, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await tx
      .select({ id: schema.adaptations.id, deliveryOutcome: ADAPTATION_COLUMNS.deliveryOutcome })
      .from(schema.adaptations)
      .where(and(eq(schema.adaptations.orgId, orgId), inArray(schema.adaptations.id, ids)));
    return new Set(
      rows
        .filter((row) => row.deliveryOutcome === "unknown" || row.deliveryOutcome === "partial")
        .map((row) => row.id),
    );
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
   * Hide a finished or still-unapproved item while keeping its adaptations,
   * versions and publication receipts intact. A queued, scheduled, manual or
   * in-flight delivery must be stopped explicitly with Reject first.
   *
   * Lock every adaptation before the parent, in the same order as publishing
   * and approval. The status check therefore observes a worker's committed
   * claim and holds that verdict steady until the archive write commits.
   */
  async archive(orgId: string, id: string) {
    await db.transaction(async (tx) => {
      await this.requireItem(tx, orgId, id);
      const adaptations = await this.lockAdaptations(tx, orgId, id, [...ADAPTATION_STATUSES]);
      const [item] = await tx
        .select({
          status: schema.contentItems.status,
        })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
        .limit(1)
        .for("update");
      if (!item) throw notFound("content_not_found", "Content item not found");
      if (item.status === "archived") return;
      if (
        adaptations.some((adaptation) =>
          (ACTIVE_ARCHIVE_DELIVERY_STATUSES as readonly AdaptationStatus[]).includes(
            adaptation.status,
          ),
        )
      ) {
        throw conflict(
          "content_archive_delivery_active",
          "Stop every active delivery before archiving this content",
        );
      }
      await tx
        .update(schema.contentItems)
        .set({ status: "archived", archivedFromStatus: item.status })
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)));
    });
    return this.get(orgId, id);
  }

  /**
   * One editorial veto: suppress the source topic and retire its still-unsent
   * draft together. The first run is the same deterministic lineage displayed
   * by get(); user input never supplies a topic ID.
   *
   * Lock the brand before the topic, then the run, adaptations and item. Topic
   * deletion's SET NULL foreign key can lock a run after its topic, so taking
   * the topic first also prevents a delete/veto cycle. The run link is read
   * without a lock first and verified again after acquiring its lock.
   */
  async blockTopicAndArchive(orgId: string, id: string, reason: string) {
    await db.transaction(async (tx) => {
      const [candidate] = await tx
        .select({ brandId: schema.contentItems.brandId })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
        .limit(1);
      if (!candidate) throw notFound("content_not_found", "Content item not found");

      // Matches the existing topic-block path's brand lock and serializes
      // concurrent topic planning/suggestion completion before the veto.
      const [brand] = await tx
        .select({ id: schema.brands.id })
        .from(schema.brands)
        .where(and(eq(schema.brands.orgId, orgId), eq(schema.brands.id, candidate.brandId)))
        .for("no key update");
      if (!brand) throw notFound("content_not_found", "Content item not found");

      const [lineage] = await tx
        .select({ id: schema.pipelineRuns.id, topicId: schema.pipelineRuns.topicId })
        .from(schema.pipelineRuns)
        .where(
          and(
            eq(schema.pipelineRuns.orgId, orgId),
            eq(schema.pipelineRuns.brandId, candidate.brandId),
            eq(schema.pipelineRuns.contentItemId, id),
          ),
        )
        .orderBy(asc(schema.pipelineRuns.createdAt), asc(schema.pipelineRuns.id))
        .limit(1);
      if (!lineage?.topicId) {
        throw conflict("content_topic_unlinked", "This draft has no linked topic to block");
      }

      const [topic] = await tx
        .select({ id: schema.topics.id, blockedAt: schema.topics.blockedAt })
        .from(schema.topics)
        .where(
          and(
            eq(schema.topics.orgId, orgId),
            eq(schema.topics.brandId, candidate.brandId),
            eq(schema.topics.id, lineage.topicId),
          ),
        )
        .for("update");
      if (!topic)
        throw conflict("content_topic_unlinked", "This draft's linked topic is unavailable");

      const [run] = await tx
        .select({ topicId: schema.pipelineRuns.topicId })
        .from(schema.pipelineRuns)
        .where(
          and(
            eq(schema.pipelineRuns.id, lineage.id),
            eq(schema.pipelineRuns.orgId, orgId),
            eq(schema.pipelineRuns.brandId, candidate.brandId),
            eq(schema.pipelineRuns.contentItemId, id),
          ),
        )
        .for("update");
      if (!run || run.topicId !== topic.id) {
        throw conflict("content_topic_unlinked", "This draft's linked topic changed");
      }

      const adaptations = await this.lockAdaptations(tx, orgId, id, [...ADAPTATION_STATUSES]);
      const [item] = await tx
        .select({
          brandId: schema.contentItems.brandId,
          status: schema.contentItems.status,
        })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
        .for("update");
      if (!item || item.brandId !== candidate.brandId) {
        throw notFound("content_not_found", "Content item not found");
      }
      if (item.status !== "draft") {
        throw conflict("content_topic_veto_not_draft", "Only a draft can be vetoed with its topic");
      }
      if (
        adaptations.some(
          (adaptation) => adaptation.status !== "pending" || adaptation.attemptCount > 0,
        )
      ) {
        throw conflict(
          "content_archive_delivery_active",
          "Stop every delivery before blocking this draft's topic",
        );
      }

      // Use the topic route's idempotent block semantics, including its
      // revision and archived status. Both writes roll back on either failure.
      if (!topic.blockedAt) {
        await tx
          .update(schema.topics)
          .set({
            blockedAt: new Date(),
            blockReason: reason,
            status: "archived",
            revision: sql`${schema.topics.revision} + 1`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(schema.topics.orgId, orgId),
              eq(schema.topics.brandId, candidate.brandId),
              eq(schema.topics.id, topic.id),
            ),
          );
      }
      await tx
        .update(schema.contentItems)
        .set({ status: "archived", archivedFromStatus: "draft" })
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)));
    });
    return this.get(orgId, id);
  }

  /** Restore the archived status without scheduling or enqueueing a delivery. */
  async restore(orgId: string, id: string) {
    await db.transaction(async (tx) => {
      await this.requireItem(tx, orgId, id);
      await this.lockAdaptations(tx, orgId, id, [...ADAPTATION_STATUSES]);
      const [item] = await tx
        .select({
          status: schema.contentItems.status,
          archivedFromStatus: schema.contentItems.archivedFromStatus,
        })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
        .limit(1)
        .for("update");
      if (!item) throw notFound("content_not_found", "Content item not found");
      if (item.status !== "archived") return;
      if (!item.archivedFromStatus || item.archivedFromStatus === "archived") {
        throw conflict("content_archived", "The archived status could not be restored");
      }
      await tx
        .update(schema.contentItems)
        .set({ status: item.archivedFromStatus, archivedFromStatus: null })
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)));
    });
    return this.get(orgId, id);
  }

  /**
   * Permanently remove an archived, unpublished draft or rejection. Publication
   * receipts are evidence of a delivery and must never disappear with an item.
   * A delivery attempt without a receipt is evidence too: attemptCount is
   * checked even when the worker could not record the platform's answer.
   *
   * Lock every linked adaptation in ID order before the parent, as required by
   * docs/lock-order.md. Publication writers hold that same adaptation lock, so
   * the history check cannot race an in-flight receipt. The final unlocked
   * adaptation read catches a new row inserted while we waited for the parent;
   * once its FOR UPDATE lock is held, the item's FK blocks further inserts.
   */
  async delete(orgId: string, id: string): Promise<void> {
    await db.transaction(async (tx) => {
      await this.requireItem(tx, orgId, id);
      const adaptations = await this.lockAdaptations(tx, orgId, id, [...ADAPTATION_STATUSES]);
      const [item] = await tx
        .select({
          status: schema.contentItems.status,
          archivedFromStatus: schema.contentItems.archivedFromStatus,
          isSafeToDelete: schema.contentItems.isSafeToDelete,
        })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
        .limit(1)
        .for("update");
      if (!item) throw notFound("content_not_found", "Content item not found");
      if (item.status !== "archived") {
        throw conflict(
          "content_delete_requires_archive",
          "Archive this content before deleting it",
        );
      }
      if (item.archivedFromStatus !== "draft" && item.archivedFromStatus !== "rejected") {
        throw conflict(
          "content_delete_not_draft",
          "Only archived drafts and rejected content can be permanently deleted",
        );
      }
      if (!item.isSafeToDelete) {
        throw conflict(
          "content_delete_has_delivery_history",
          "Delivery history cannot be ruled out for this content",
        );
      }

      // A generated draft also lives in pipeline_runs.steps. Cascading the
      // content item only nulls that run's FK; it does not erase the checkpoint
      // text, which GET /runs/:id can still return. Refuse until run retention
      // and redaction have an explicit design.
      const [generationRun] = await tx
        .select({ id: schema.pipelineRuns.id })
        .from(schema.pipelineRuns)
        .where(and(eq(schema.pipelineRuns.orgId, orgId), eq(schema.pipelineRuns.contentItemId, id)))
        .limit(1);
      if (generationRun) {
        throw conflict(
          "content_delete_has_generation_history",
          "Generated drafts cannot be permanently deleted while their run is retained",
        );
      }

      const currentAdaptations = await tx
        .select({ id: schema.adaptations.id })
        .from(schema.adaptations)
        .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.contentItemId, id)));
      if (
        currentAdaptations.length !== adaptations.length ||
        currentAdaptations.some((row) => !adaptations.some((locked) => locked.id === row.id))
      ) {
        throw conflict(
          "content_delete_has_delivery_history",
          "Content channels changed during deletion",
        );
      }
      if (
        adaptations.some(
          (adaptation) =>
            adaptation.attemptCount > 0 ||
            adaptation.status === "published" ||
            adaptation.status === "failed" ||
            (ACTIVE_ARCHIVE_DELIVERY_STATUSES as readonly AdaptationStatus[]).includes(
              adaptation.status,
            ),
        )
      ) {
        throw conflict(
          "content_delete_has_delivery_history",
          "Content with active or attempted deliveries cannot be permanently deleted",
        );
      }
      if (adaptations.length > 0) {
        const [publication] = await tx
          .select({ id: schema.publications.id })
          .from(schema.publications)
          .where(
            and(
              eq(schema.publications.orgId, orgId),
              inArray(
                schema.publications.adaptationId,
                adaptations.map((adaptation) => adaptation.id),
              ),
            ),
          )
          .limit(1);
        if (publication) {
          throw conflict(
            "content_delete_has_delivery_history",
            "Content with publication history cannot be permanently deleted",
          );
        }
      }

      const deleted = await tx
        .delete(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
        .returning({ id: schema.contentItems.id });
      if (deleted.length === 0) throw notFound("content_not_found", "Content item not found");
    });
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
  async approve(
    orgId: string,
    id: string,
    requestedScheduledAt: Date | null,
    delayMinutes: 30 | null = null,
  ) {
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
    if (requestedScheduledAt !== null && requestedScheduledAt.getTime() <= Date.now()) {
      throw badRequest("schedule_in_past", "scheduledAt must be in the future");
    }
    await db.transaction(async (tx) => {
      await this.holdDecisionOrganization(tx, orgId);
      await this.requireItem(tx, orgId, id);
      const targets = await this.lockAdaptations(tx, orgId, id, [
        "pending",
        "failed",
        "scheduled",
        "manual_ready",
      ]);
      // A relative shortcut uses the database clock after any lock wait. The
      // browser may be minutes ahead or behind; the queue must still mean a
      // full 30 minutes from this decision.
      let scheduledAt = requestedScheduledAt;
      if (delayMinutes !== null) {
        const [clock] = await tx
          .select({
            nowMs: sql<number>`extract(epoch from clock_timestamp()) * 1000`.mapWith(Number),
          })
          .from(schema.contentItems)
          .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
          .limit(1);
        if (!clock) throw notFound("content_not_found", "Content item not found");
        scheduledAt = new Date(clock.nowMs + delayMinutes * 60_000);
      }
      await this.requireNotPublished(tx, orgId, id, { of: "the item" });
      const journalDecision = await this.shouldJournalDecision(
        tx,
        orgId,
        id,
        "approved",
        targets.some((target) => target.status === "failed"),
      );
      // After `requireNotPublished` too: an item whose channels are gone AND
      // which already published from them is a published item first.
      await this.requireAdaptations(tx, orgId, id);
      await requireClientReviewApproval(tx, orgId, id);
      const [unreviewedImage] = await tx
        .select({ id: schema.contentImageSlots.id })
        .from(schema.contentImageSlots)
        .where(
          and(
            eq(schema.contentImageSlots.orgId, orgId),
            eq(schema.contentImageSlots.contentItemId, id),
            eq(schema.contentImageSlots.needsReview, true),
          ),
        )
        .limit(1);
      if (unreviewedImage) {
        throw conflict(
          "content_images_need_review",
          "Review the generated article images and their descriptions before approving",
        );
      }
      /*
       * A DELIVERY NOBODY CAN SPEAK FOR IS NOT RE-SENT, and the skip is PER
       * ROW.
       *
       * An adaptation whose last finished attempt ended `unknown` may already
       * be live in someone's channel: the request left this process and the
       * answer never came back, so nothing here can tell. Re-sending it is how
       * a person ends up with two copies of one post — which is the whole
       * reason `deliveryOutcome` exists, and which until now was defended by
       * two sentences on two screens. Advice, not a control: the adaptation
       * column has no `unknown`, so the row reads `failed` and `approve`
       * targeted it like any other.
       *
       * Per row rather than per item, because a four-channel post with one
       * unknown half still has provably undelivered halves, and refusing the
       * whole request would leave the person no way to send them. The skip
       * costs nothing it did not already cost: nothing else re-sends by itself.
       *
       * THE READ IS AFTER `lockAdaptations`, for the reason
       * `requireNotPublished` gives at length: delivery state read before the
       * lock is stale against a worker landing a moment later. It takes no new
       * lock and changes no order (`docs/lock-order.md`). It is also BEFORE the
       * schedule guard, which is the next comment's subject.
       */
      const unknown = await this.unknownDeliveries(
        tx,
        orgId,
        targets.map((target) => target.id),
      );
      const manualReady = targets.filter((target) => target.status === "manual_ready");
      const sendable = targets.filter(
        (target) => target.status !== "manual_ready" && !unknown.has(target.id),
      );
      const platforms = sendable.length
        ? await tx
            .select({ id: schema.channels.id, platform: schema.channels.platform })
            .from(schema.channels)
            .where(
              and(
                eq(schema.channels.orgId, orgId),
                inArray(
                  schema.channels.id,
                  sendable.map((target) => target.channelId),
                ),
              ),
            )
        : [];
      const cover = await tx
        .select({
          id: schema.contentItems.coverMediaId,
          videoId: schema.contentItems.videoMediaId,
          body: schema.contentItems.body,
        })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
        .limit(1);
      const coveredItem = cover[0];
      if (coveredItem?.id && coveredItem.videoId) {
        throw conflict("content_media_invalid", "A post cannot publish both a cover and a video");
      }
      if (coveredItem?.id) {
        if (
          platforms.some(
            (channel) =>
              !(COVER_SUPPORTED_PLATFORMS as readonly string[]).includes(channel.platform),
          ) ||
          manualReady.length
        ) {
          throw conflict(
            "content_media_unsupported",
            "Covers currently publish only to Telegram, VK, MAX, and Bluesky channels",
          );
        }
      }
      // Approval is the final boundary before a queued publisher can read this
      // text. Preflight the exact inherited or overridden channel body now,
      // including historic rows that bypassed today's editor validation.
      const overrideBodies = await tx
        .select({ body: schema.adaptations.body, channelId: schema.adaptations.channelId })
        .from(schema.adaptations)
        .where(
          and(
            eq(schema.adaptations.orgId, orgId),
            eq(schema.adaptations.contentItemId, id),
            inArray(
              schema.adaptations.channelId,
              platforms
                .filter((channel) => channel.platform === "telegram")
                .map((channel) => channel.id),
            ),
          ),
        );
      for (const row of overrideBodies) {
        const problem = telegramTextProblem(
          row.body ?? coveredItem?.body ?? "",
          coveredItem?.id != null,
          coveredItem?.videoId != null,
        );
        if (problem) {
          throw conflict(
            coveredItem?.videoId &&
              (row.body ?? coveredItem.body).length > TELEGRAM_PHOTO_CAPTION_LENGTH
              ? "content_media_caption_too_long"
              : "invalid_request",
            problem,
          );
        }
      }
      if (coveredItem?.videoId) {
        if (
          platforms.some((channel) => !["telegram", "vk"].includes(channel.platform)) ||
          manualReady.length
        ) {
          throw conflict(
            "content_media_unsupported",
            "Videos currently publish only to Telegram and VK channels",
          );
        }
      }
      const platformByChannel = new Map(platforms.map((row) => [row.id, row.platform]));
      if (
        scheduledAt !== null &&
        (manualReady.length > 0 ||
          sendable.some((target) =>
            isManualPlatform(platformByChannel.get(target.channelId) ?? ""),
          ))
      ) {
        throw badRequest(
          "manual_schedule_unsupported",
          "Manual VC.ru publishing cannot be scheduled from Pubrick",
        );
      }
      /*
       * A REQUEST THAT NAMES A TIME MAY NOT SKIP A CHANNEL AT ALL — and this is
       * why the unknown rows are read BEFORE the schedule is checked rather
       * than after it.
       *
       * `requireScheduleReachesEveryChannel` reads the adaptation STATUS
       * column, which has no value for "unknown": a row nobody can speak for
       * reads `failed`, so a timed approve over `{failed, unknown}` passed the
       * check whose whole job is the sentence its name is, then skipped that
       * channel and answered 200. The reader was told the post goes out, whole,
       * at the time they picked.
       *
       * Skipping is right for "publish now" and wrong for a schedule, and the
       * difference is the promise, not the mechanism: "now" says nothing about
       * the row it leaves alone, which the response still reports as it was,
       * while a time is a claim about every channel at once. So a timed request
       * that would skip anything is refused — the standard this guard, the
       * empty-target refusal below and `requireAdaptations` all set.
       *
       * BEFORE the guard, so the reader is told what is actually in their way:
       * the unknown delivery they must go and look at, rather than a sentence
       * about a queue.
       */
      if (scheduledAt !== null) {
        if (unknown.size > 0) {
          throw conflict("delivery_outcome_unknown", DELIVERY_OUTCOME_UNKNOWN_MESSAGE);
        }
        // Only for a request that names a time: "Publish now" over a queued or
        // publishing channel is already true of it. See the method's own comment.
        await this.requireScheduleReachesEveryChannel(tx, orgId, id);
      }
      // After `requireNotPublished`: an item already live in a channel gets the
      // message about the post that went out, not one about reading it. Before
      // the loop, so a refusal costs no queue work.
      await this.requireHumanInvolvement(tx, orgId, id);

      /*
       * AND WHEN THE SKIP LEAVES NOTHING TO ENQUEUE it refuses rather than
       * answering 200 — the same judgement `requireAdaptations` and
       * `requireScheduleReachesEveryChannel` make, and for the same reason: a
       * 200 that did no work is a report the reader has to discover is false.
       * The way out is the resolver (`assertDelivery`), which this refusal
       * shipped with — without it a person could only finish the post by
       * deleting the channel.
       *
       * Unreachable for a timed request, which is refused above before it can
       * skip anything: this is the "publish now" ending.
       */
      if (sendable.length === 0 && unknown.size > 0) {
        throw conflict("delivery_outcome_unknown", DELIVERY_OUTCOME_UNKNOWN_MESSAGE);
      }
      if (sendable.length === 0 && manualReady.length > 0) {
        throw conflict(
          "manual_publication_pending",
          "This post is ready for you to publish manually",
        );
      }

      for (const adaptation of sendable) {
        if (isManualPlatform(platformByChannel.get(adaptation.channelId) ?? "")) {
          await tx
            .update(schema.adaptations)
            .set({
              status: "manual_ready",
              scheduledAt: null,
              lastError: null,
              failureReason: null,
            })
            .where(
              and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptation.id)),
            );
          continue;
        }
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
            // `null` FOR "PUBLISH NOW", and that is load-bearing rather than
            // incidental. A row that missed its slot is `failed` with the slot
            // still on it; "Publish now" has to erase the slot, or the worker
            // would load the same overdue `scheduled_at`, find itself past the
            // bound again, and fail the row for ever — a post nobody could ever
            // send. Writing it conditionally (`...(scheduledAt && { scheduledAt })`)
            // is exactly that loop.
            scheduledAt,
            lastError: null,
            // Beside the `lastError` it already clears, for the same reason:
            // the row is outstanding again and the previous attempt's verdict
            // is not its verdict. Leaving the code would have the screen
            // caption a re-approved row "Missed its slot".
            failureReason: null,
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
      if (journalDecision.should && (sendable.length > 0 || manualReady.length > 0)) {
        await this.appendPromptDecision(tx, orgId, id, "approved", journalDecision.ordinal);
      }
    });

    return this.get(orgId, id);
  }

  /** Move exactly one automatic channel's outstanding job without re-approving its siblings. */
  async rescheduleAdaptation(
    orgId: string,
    contentItemId: string,
    adaptationId: string,
    expectedScheduledAt: Date,
    scheduledAt: Date,
  ) {
    await db.transaction(async (tx) => {
      // The publish worker claims this same row before any external call. A
      // second request must wait for the first reschedule, then compare the
      // time in a NEW statement under this lock (READ COMMITTED snapshot).
      const [locked] = await tx
        .select({ id: schema.adaptations.id })
        .from(schema.adaptations)
        .where(
          and(
            eq(schema.adaptations.orgId, orgId),
            eq(schema.adaptations.contentItemId, contentItemId),
            eq(schema.adaptations.id, adaptationId),
          ),
        )
        .limit(1)
        .for("update");
      if (!locked) throw notFound("adaptation_not_found", "Adaptation not found");

      const [current] = await tx
        .select({
          channelId: schema.adaptations.channelId,
          status: schema.adaptations.status,
          scheduledAt: schema.adaptations.scheduledAt,
          attemptCount: schema.adaptations.attemptCount,
          platform: schema.channels.platform,
          nowMs: sql<number>`extract(epoch from clock_timestamp()) * 1000`.mapWith(Number),
        })
        .from(schema.adaptations)
        .innerJoin(
          schema.channels,
          and(
            eq(schema.channels.orgId, orgId),
            eq(schema.channels.id, schema.adaptations.channelId),
          ),
        )
        .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptationId)))
        .limit(1);
      if (!current) throw notFound("adaptation_not_found", "Adaptation not found");

      // Archive/reject take adaptation locks before changing the parent, so
      // this read stays valid until commit. Do not lock the item first: that
      // would invert the worker's adaptation -> item lock order.
      const [item] = await tx
        .select({ status: schema.contentItems.status })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, contentItemId)))
        .limit(1);
      if (!item) throw notFound("content_not_found", "Content item not found");
      if (item.status !== "approved" && item.status !== "partially_published") {
        throw conflict(
          "schedule_parent_not_ready",
          "This post is no longer approved for scheduling",
        );
      }
      if (
        current.status !== "scheduled" ||
        !current.scheduledAt ||
        isManualPlatform(current.platform)
      ) {
        throw conflict(
          "schedule_not_scheduled",
          "This channel has no scheduled automatic delivery to move",
        );
      }
      if (current.scheduledAt.getTime() !== expectedScheduledAt.getTime()) {
        throw conflict(
          "schedule_changed",
          "This channel's scheduled time changed; reload before moving it",
        );
      }
      // A previous known failure is evidence that nothing was delivered, and
      // approving its retry already created this scheduled job. A published
      // receipt or an active claim is different: either can be live outside
      // Pubrick, so moving the job would hide a second send behind a new slot.
      const [unsafeReceipt] = await tx
        .select({ id: schema.publications.id })
        .from(schema.publications)
        .where(
          and(
            eq(schema.publications.orgId, orgId),
            eq(schema.publications.adaptationId, adaptationId),
            inArray(schema.publications.status, ["in_flight", "published"]),
          ),
        )
        .limit(1);
      // An unknown result becomes safe only when a later human assertion says
      // it was not delivered. A subsequent worker failure alone cannot settle
      // that earlier send, even though it would be the last finished receipt.
      const [lastUncertainOrResolution] = await tx
        .select({ status: schema.publications.status })
        .from(schema.publications)
        .where(
          and(
            eq(schema.publications.orgId, orgId),
            eq(schema.publications.adaptationId, adaptationId),
            or(
              eq(schema.publications.status, "unknown"),
              and(
                eq(schema.publications.status, "failed"),
                isNotNull(schema.publications.assertedAt),
              ),
            ),
          ),
        )
        .orderBy(desc(schema.publications.createdAt), desc(schema.publications.id))
        .limit(1);
      if (unsafeReceipt || lastUncertainOrResolution?.status === "unknown") {
        throw conflict(
          "schedule_has_history",
          "This channel has an unresolved or delivered attempt; inspect it before scheduling again",
        );
      }

      // Both comparisons use the DB clock AFTER any lock wait. pg-boss runs a
      // past startAfter immediately; a short guard also avoids changing a job
      // already due in the next dispatch window.
      const now = current.nowMs;
      if (scheduledAt.getTime() <= now) {
        throw badRequest("schedule_in_past", "scheduledAt must be in the future");
      }
      if (
        Math.min(current.scheduledAt.getTime(), scheduledAt.getTime()) <=
        now + MIN_RESCHEDULE_LEAD_MS
      ) {
        throw conflict(
          "schedule_too_close",
          "Choose a time at least one minute away before this delivery is due",
        );
      }
      if (scheduledAt.getTime() === current.scheduledAt.getTime()) return;

      // Cancellation and replacement share this transaction with the row.
      // The cancelled pg-boss id remains, so a fresh attempt count is required.
      await this.queue.cancelPublish(tx, adaptationId, orgId);
      const attemptCount = current.attemptCount + 1;
      await tx
        .update(schema.adaptations)
        .set({ scheduledAt, attemptCount })
        .where(
          and(
            eq(schema.adaptations.orgId, orgId),
            eq(schema.adaptations.contentItemId, contentItemId),
            eq(schema.adaptations.id, adaptationId),
          ),
        );
      await this.queue.enqueuePublish(
        tx,
        { id: adaptationId, orgId, channelId: current.channelId, attemptCount },
        scheduledAt,
      );
    });
    return this.get(orgId, contentItemId);
  }

  /** Return an unsent approval to the review queue without recording a rejection. */
  async retractApproval(orgId: string, id: string) {
    await db.transaction(async (tx) => {
      await this.holdDecisionOrganization(tx, orgId);
      await this.requireItem(tx, orgId, id);
      // A worker claims an adaptation before making the external request. Lock
      // every row first, in the same order as approval and publishing, so a
      // claim cannot pass the checks below while its cancellation commits.
      const adaptations = await this.lockAdaptations(tx, orgId, id, [...ADAPTATION_STATUSES]);
      const [item] = await tx
        .select({
          status: schema.contentItems.status,
          isSafeToDelete: schema.contentItems.isSafeToDelete,
        })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, id)))
        .limit(1)
        .for("update");
      if (!item) throw notFound("content_not_found", "Content item not found");
      if (item.status !== "approved") {
        throw conflict(
          "approval_retraction_not_approved",
          "Only an approved post can return to drafts",
        );
      }
      if (
        !item.isSafeToDelete ||
        adaptations.length === 0 ||
        adaptations.some(
          (adaptation) => !["pending", "scheduled", "queued"].includes(adaptation.status),
        )
      ) {
        throw conflict(
          "approval_retraction_delivery_started",
          "A delivery has started or finished; inspect the channel results before changing this post",
        );
      }
      const [receipt] = await tx
        .select({ id: schema.publications.id })
        .from(schema.publications)
        .where(
          and(
            eq(schema.publications.orgId, orgId),
            inArray(
              schema.publications.adaptationId,
              adaptations.map((adaptation) => adaptation.id),
            ),
          ),
        )
        .limit(1);
      if (receipt) {
        throw conflict(
          "approval_retraction_delivery_started",
          "A delivery has started or finished; inspect the channel results before changing this post",
        );
      }
      for (const adaptation of adaptations) {
        const hadJob = adaptation.status === "scheduled" || adaptation.status === "queued";
        if (hadJob) await this.queue.cancelPublish(tx, adaptation.id, orgId);
        await tx
          .update(schema.adaptations)
          .set({
            status: "pending",
            scheduledAt: null,
            attemptCount: adaptation.attemptCount + (hadJob ? 1 : 0),
            lastError: null,
            failureReason: null,
          })
          .where(
            and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptation.id)),
          );
      }
      await this.setItemStatus(tx, orgId, id, "draft");
    });
    return this.get(orgId, id);
  }

  /**
   * A PERSON SETTLES A DELIVERY NOBODY ELSE CAN — "Mark as delivered" and
   * "Mark as not delivered", per adaptation.
   *
   * WHY IT EXISTS AT ALL. An attempt whose answer never came back leaves the
   * adaptation `failed` with an `unknown` receipt, and `approve` now skips such
   * a row rather than posting a second copy of a message that may be live. That
   * refusal cannot ship alone: nothing else in the product moves a row off
   * `failed`+unknown — `reject` touches only outstanding rows, `PATCH` writes
   * bodies, a receipt needs a delivery, and `sweepAbandoned` acts only on
   * `publishing` rows — so the post would be finishable only by deleting the
   * channel, against this product's own standard
   * (`requireScheduleReachesEveryChannel`). The person opens the channel, looks,
   * and says what they found; this records it.
   *
   * WHAT IT WRITES IS AN ORDINARY RECEIPT. "Delivered" is a `published`
   * `publications` row and a `published` adaptation; "not delivered" is a
   * `failed` receipt and an adaptation left `failed`. Nothing downstream has to
   * be taught about human verdicts: the worker's own duplicate guard
   * (`hasPublished`) already refuses to send where a `published` receipt exists,
   * and `deliveryOutcome` already stops saying `unknown` once the last FINISHED
   * receipt says something else — so "not delivered" puts the delivery back in
   * reach of "Publish now" by the same expression that took it out. The one
   * thing the receipt carries that a worker's does not is `asserted_by`, which
   * is what stops the screen rendering a person's word as a platform's.
   *
   * THE OUTCOME IS READ UNDER THE ADAPTATION'S ROW LOCK, IN ITS OWN STATEMENT.
   * Two presses race otherwise, both read `unknown`, and the loser meets
   * `publications_one_published_per_adaptation` as a raw `23505` — a 500 for a
   * request whose only fault is being second. The read is a SEPARATE statement
   * from the lock rather than a subquery inside it, and that is load-bearing
   * under READ COMMITTED: a statement's snapshot is taken when the statement
   * starts, so the target list of the locking `SELECT ... FOR UPDATE` would be
   * computed from a snapshot older than the commit it just waited for, and the
   * loser would read the outcome it was waiting to stop reading.
   *
   * THE LOCK ORDER IS THE DOCUMENTED ONE, and no new edge:
   * `adaptations` (one row) → the `publications` insert's `FOR KEY SHARE` on
   * `channels` → `content_items`. That is `markPublished`'s own path, which is
   * why a resolver and a landing worker on one adaptation serialise instead of
   * deadlocking. `docs/lock-order.md` names this transaction.
   *
   * AND IT PROMOTES THE ITEM, because either verdict makes the row terminal and
   * a delivery that makes a row terminal is exactly when the item is
   * recomputed. Through `nextItemStatus` (`@pubrick/shared`) — the same fold the
   * worker's `recomputeItemStatus` asks, not a second copy of the rule.
   *
   * WHAT IT REFUSES. A row with a delivery still in flight gets the pinned
   * code for the status it is actually in (`adaptation_pinned_*`), because
   * asserting an outcome for an attempt that has not ended yet is asserting
   * about the wrong attempt. A row whose outcome is NOT in doubt gets
   * `delivery_outcome_already_known`: there is nothing here for a person to
   * know that the record does not already say, and answering 200 would let a
   * second press overwrite a platform's own answer with a guess.
   */
  async assertDelivery(
    orgId: string,
    contentItemId: string,
    adaptationId: string,
    delivered: boolean,
    userId: string,
    partialResolution?: "completed" | "removed",
  ) {
    await db.transaction(async (tx) => {
      // `adaptations` first — the product's one lock order. One row, by primary
      // key, so there is no multi-row ordering question to answer here.
      const locked = await tx
        .select({ id: schema.adaptations.id })
        .from(schema.adaptations)
        .where(
          and(
            eq(schema.adaptations.orgId, orgId),
            eq(schema.adaptations.contentItemId, contentItemId),
            eq(schema.adaptations.id, adaptationId),
          ),
        )
        .limit(1)
        .for("update");
      if (locked.length === 0) throw notFound("adaptation_not_found", "Adaptation not found");

      // UNDER the lock, and in its own statement so it reads a snapshot taken
      // after whatever that lock waited for — see this method's own comment.
      const current = (
        await tx
          .select({
            channelId: schema.adaptations.channelId,
            status: schema.adaptations.status,
            attemptCount: schema.adaptations.attemptCount,
            deliveryOutcome: ADAPTATION_COLUMNS.deliveryOutcome,
            partialTelegram: ADAPTATION_COLUMNS.partialTelegram,
          })
          .from(schema.adaptations)
          .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptationId)))
          .limit(1)
      )[0];
      if (!current) throw notFound("adaptation_not_found", "Adaptation not found");

      // Archive locks this adaptation before changing the parent. This read is
      // stable for the rest of the transaction while our adaptation lock is
      // held, without moving content_items ahead of the publication's channel
      // foreign-key lock in the global lock order.
      const [item] = await tx
        .select({ status: schema.contentItems.status })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, contentItemId)))
        .limit(1);
      if (item?.status === "archived") {
        throw conflict("content_archived", "Restore this archived content before changing it");
      }

      // The in-flight statuses first, and the records that answer them are the
      // ones `updateAdaptation` uses: one reading of "this delivery is not
      // yours to decide", so the two routes cannot answer differently.
      if (!isEditableAdaptationStatus(current.status)) {
        throw conflict(
          PINNED_ADAPTATION_CODE[current.status],
          PINNED_ADAPTATION_MESSAGE[current.status],
        );
      }
      if (current.deliveryOutcome !== "unknown" && current.deliveryOutcome !== "partial") {
        throw conflict(
          "delivery_outcome_already_known",
          "This delivery's outcome is already known, so there is nothing to say about it",
        );
      }
      if (current.partialTelegram) {
        if (partialResolution !== (delivered ? "completed" : "removed")) {
          throw conflict(
            "delivery_outcome_unknown",
            "Confirm the full Telegram post was delivered, or that every accepted part was removed",
          );
        }
      } else if (partialResolution !== undefined) {
        throw conflict(
          "delivery_outcome_already_known",
          "This delivery has no partial Telegram post",
        );
      }

      await tx
        .update(schema.adaptations)
        .set({
          status: delivered ? "published" : "failed",
          // Cleared on BOTH verdicts. The sentence stored there says the
          // outcome could not be confirmed, and after this call it can: leaving
          // it would have the screen print "outcome unknown" underneath the
          // answer somebody just gave. There is no platform error to report in
          // its place, because no platform answered.
          lastError: null,
          // The code goes with the sentence, on both verdicts and for the same
          // reason. A person who looked at the channel and said "not delivered"
          // has replaced `outcome_unknown` with their own word, and none of the
          // nine coded reasons is a human verdict — the provenance of this one
          // lives on the receipt (`asserted_by`), which is where a reader that
          // must not render a person's word as a platform's already looks.
          failureReason: null,
        })
        .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptationId)));

      await tx.insert(schema.publications).values({
        orgId,
        adaptationId,
        channelId: current.channelId,
        status: delivered ? "published" : "failed",
        // A partial Telegram receipt already has the platform-confirmed first
        // message id and URL. The person attests completion of the rest.
        // Generic unknown outcomes still have no id or link.
        externalId: delivered ? (current.partialTelegram?.photoId ?? null) : null,
        externalUrl: delivered ? (current.partialTelegram?.photoUrl ?? null) : null,
        error: null,
        attempt: current.attemptCount,
        // WHO, AND WHEN — and the two are written together because only the
        // second survives the first. `asserted_by` is `ON DELETE SET NULL`, so
        // a date derived from it dies with the account and the screen goes back
        // to claiming a platform confirmed the post (`assertedAt` in
        // `ADAPTATION_COLUMNS`, migration 0017). `now()` rather than a
        // JavaScript `Date`: it is the same transaction clock `created_at`
        // defaults to, so the receipt and the assertion cannot disagree about
        // their own instant.
        assertedBy: userId,
        assertedAt: sql`now()`,
      });

      // `content_items` last, and only now: the row is terminal either way, so
      // this is the same promotion a landing delivery performs, through the
      // same fold.
      const parent = await tx
        .select({ id: schema.contentItems.id })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, contentItemId)))
        .limit(1)
        .for("update");
      if (parent.length === 0) return;
      const siblings = await tx
        .select({ status: schema.adaptations.status })
        .from(schema.adaptations)
        .where(
          and(
            eq(schema.adaptations.orgId, orgId),
            eq(schema.adaptations.contentItemId, contentItemId),
          ),
        );
      const next = nextItemStatus(siblings.map((sibling) => sibling.status));
      if (next) await this.setItemStatus(tx, orgId, contentItemId, next);
    });

    return this.get(orgId, contentItemId);
  }

  /** Record a person's VC.ru publication only after they supply its public URL. */
  async confirmManualPublication(
    orgId: string,
    contentItemId: string,
    adaptationId: string,
    url: string,
    userId: string,
  ) {
    await db.transaction(async (tx) => {
      const locked = await tx
        .select({ id: schema.adaptations.id })
        .from(schema.adaptations)
        .where(
          and(
            eq(schema.adaptations.orgId, orgId),
            eq(schema.adaptations.contentItemId, contentItemId),
            eq(schema.adaptations.id, adaptationId),
          ),
        )
        .limit(1)
        .for("update");
      if (locked.length === 0) throw notFound("adaptation_not_found", "Adaptation not found");

      const current = (
        await tx
          .select({
            channelId: schema.adaptations.channelId,
            status: schema.adaptations.status,
            attemptCount: schema.adaptations.attemptCount,
            platform: schema.channels.platform,
          })
          .from(schema.adaptations)
          .innerJoin(schema.channels, eq(schema.channels.id, schema.adaptations.channelId))
          .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptationId)))
          .limit(1)
      )[0];
      if (current?.platform !== "vc_ru" || current.status !== "manual_ready") {
        throw conflict(
          "manual_publication_not_ready",
          "This VC.ru post is not ready for manual confirmation",
        );
      }

      await tx.insert(schema.publications).values({
        orgId,
        adaptationId,
        channelId: current.channelId,
        status: "published",
        externalUrl: url,
        externalId: null,
        error: null,
        attempt: current.attemptCount,
        assertedBy: userId,
        assertedAt: sql`now()`,
      });
      await tx
        .update(schema.adaptations)
        .set({ status: "published", lastError: null, failureReason: null })
        .where(and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptationId)));

      const parent = await tx
        .select({ id: schema.contentItems.id })
        .from(schema.contentItems)
        .where(and(eq(schema.contentItems.orgId, orgId), eq(schema.contentItems.id, contentItemId)))
        .limit(1)
        .for("update");
      if (parent.length === 0) return;
      const siblings = await tx
        .select({ status: schema.adaptations.status })
        .from(schema.adaptations)
        .where(
          and(
            eq(schema.adaptations.orgId, orgId),
            eq(schema.adaptations.contentItemId, contentItemId),
          ),
        );
      const next = nextItemStatus(siblings.map((sibling) => sibling.status));
      if (next) await this.setItemStatus(tx, orgId, contentItemId, next);
    });
    return this.get(orgId, contentItemId);
  }

  /**
   * Rejects an item and cancels deliveries that have not claimed a send.
   *
   * Flipping `content_items.status` alone was not a rejection at all: the
   * adaptations stayed `queued`/`scheduled`, their pg-boss jobs stayed live,
   * and the worker never looked at the parent item — so approving with a
   * schedule and then rejecting still published the post the next day. Every
   * outstanding adaptation goes back to `pending` and its job is cancelled, in
   * one transaction with the status write, so the queue can never disagree
   * with the database.
   *
   * `publishing` counts as outstanding when it has no in-flight send claim.
   * A transient platform failure leaves the adaptation `publishing` for the
   * retry chain (`recordTransient` deliberately does not move the status).
   * Reject cancels that chain. Once `claimSend` has written a receipt, request
   * bytes may already be on the wire, so Reject refuses until the worker has
   * recorded the result. Cancelling then could hide a confirmed photo behind
   * `pending`, after which Approve would send a second copy.
   *
   * `attempt_count` advances for each cancelled job: a cancelled pg-boss row
   * keeps its id, so without the bump a later re-approve would derive the same
   * id, `send()` would suppress it as a duplicate, and the re-approve would
   * 409 forever (see `publishJobId`).
   *
   * A PUBLISHED item is the one case where none of that is available, and it
   * is refused with a 409 (`requireNotPublished`) rather than accepted. The
   * promise above — cancel deliveries that have not claimed a send — is not
   * something this method can keep once the post is live in
   * someone's channel; all a 200 bought was a row that said `rejected` about a
   * published post. Saying so out loud is the honest answer, and it is the one
   * the UI can render.
   *
   * A FAN-OUT WITH A LIVE CHANNEL SPLITS ON WHETHER ANYTHING IS STILL GOING
   * OUT, and that is the whole of what this method now decides:
   *
   * - something outstanding (`{published, queued | scheduled | publishing}`) —
   *   the cancel above runs exactly as it always has, the `published` rows are
   *   not touched, and the item is written `partially_published`. That is a
   *   rejection of the half that had not gone, which is the most this door can
   *   honestly do; `rejected` would say the live post was called off.
   * - nothing outstanding (`{published, failed}`) — 409. There is nothing to
   *   cancel, so the only thing a 200 could write is the lie above.
   *
   * THE `partially_published` WRITE IS THIS METHOD'S OWN, NOT THE FOLD'S, and
   * the difference is deliberate. After the cancel the fan-out is
   * `{published, pending}`, for which `nextItemStatus` returns `undefined` on
   * purpose: it answers "what did the DELIVERIES decide", and a `pending` row
   * decided nothing — it is waiting for the person who just pressed this
   * button. Routing this through the fold would mean calling a cancelled
   * delivery "over", which would then be the fold's answer everywhere,
   * including for a `pending` row nobody has rejected. So the person's act
   * names its own result, here, once.
   */
  async reject(orgId: string, id: string) {
    await db.transaction(async (tx) => {
      await this.holdDecisionOrganization(tx, orgId);
      await this.requireItem(tx, orgId, id);
      const outstanding = await this.lockAdaptations(tx, orgId, id, [
        ...OUTSTANDING_ADAPTATION_STATUSES,
        "manual_ready",
      ]);
      // A send claim means request bytes may already be on the wire. Keep the
      // adaptation in publishing until its receipt is resolved; otherwise a
      // late photo/reply result would be hidden behind pending and re-approval
      // could send a second cover. The adaptation locks above come first, as
      // on the worker's terminal path.
      const publishingIds = outstanding
        .filter((adaptation) => adaptation.status === "publishing")
        .map((adaptation) => adaptation.id);
      if (publishingIds.length > 0) {
        const [activeClaim] = await tx
          .select({ id: schema.publications.id })
          .from(schema.publications)
          .where(
            and(
              eq(schema.publications.orgId, orgId),
              inArray(schema.publications.adaptationId, publishingIds),
              eq(schema.publications.status, "in_flight"),
            ),
          )
          .limit(1)
          .for("update");
        if (activeClaim) {
          throw conflict(
            "delivery_in_flight",
            "A delivery has started; wait for its outcome before rejecting this post",
          );
        }
      }
      const live = await this.requireNotPublished(tx, orgId, id, {
        of: "the fan-out",
        hasOutstanding: outstanding.length > 0,
      });
      const journalDecision = await this.shouldJournalDecision(tx, orgId, id, "rejected");

      for (const adaptation of outstanding) {
        if (adaptation.status !== "manual_ready") {
          await this.queue.cancelPublish(tx, adaptation.id, orgId);
        }
        await tx
          .update(schema.adaptations)
          .set({
            status: "pending",
            scheduledAt: null,
            attemptCount:
              adaptation.status === "manual_ready"
                ? adaptation.attemptCount
                : adaptation.attemptCount + 1,
            // Cleared for the same reason `approve` clears it: the row is back
            // to "nothing has been attempted", and leaving the last platform
            // error behind makes a rejected adaptation look like a failed one.
            lastError: null,
            // And the coded half of that same sentence, which a screen reads
            // instead of the prose.
            failureReason: null,
          })
          .where(
            and(eq(schema.adaptations.orgId, orgId), eq(schema.adaptations.id, adaptation.id)),
          );
      }

      await this.setItemStatus(tx, orgId, id, live ? "partially_published" : "rejected");
      if (journalDecision.should && (outstanding.length > 0 || !live)) {
        await this.appendPromptDecision(tx, orgId, id, "rejected", journalDecision.ordinal);
      }
    });

    return this.get(orgId, id);
  }
}
