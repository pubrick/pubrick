import { z } from "zod";

/**
 * GENERATION RUN LIFECYCLE — the one declaration, for every package that
 * stores, moves or paints a run's status.
 *
 * Here rather than beside the column for the reason `CONTENT_STATUSES` gives:
 * `apps/web` cannot depend on `@pubrick/db` and had kept a hand-written copy of
 * this list, with a comment saying it was a copy and nothing anywhere comparing
 * the two. `@pubrick/db` types `pipeline_runs.status` with it and builds that
 * column's CHECK constraint from it, so a status still cannot be added without
 * a migration — which is the point `enumCheck` argues at length.
 *
 * `awaiting_review` is deliberately NOT a member: nothing transitions into it
 * yet, and a status no code can reach is a decision deferred without an owner.
 * When it arrives it arrives here, and the compiler then names every place that
 * has to decide what it means — see `LIVE_RUN_STATUSES` below.
 */
export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * A RUN THE QUEUE STILL OWNS: it has a pg-boss generate job behind it, it may
 * spend the org's money at any moment, and a handler may claim it.
 *
 * This was spelled as the literal `["queued", "running"]` in SIX places across
 * two apps — the brand delete's job cancellation, the cancel guard, the queue
 * strip's `open` filter, the concurrency cap's count, the worker's fence claim
 * and the dead-letter consumer's write. All six ask the same question, and the
 * answer for a status that does not exist yet has to be given once rather than
 * six times.
 *
 * `as const satisfies` rather than a `readonly RunStatus[]` annotation: both
 * make a typo a compile error, but this one keeps the literal member types,
 * which is what makes `Exclude<RunStatus, LiveRunStatus>` — and every `Record`
 * keyed on it — exhaustive by construction.
 */
export const LIVE_RUN_STATUSES = ["queued", "running"] as const satisfies readonly RunStatus[];
export type LiveRunStatus = (typeof LIVE_RUN_STATUSES)[number];

/** The complement: every status a run can no longer be moved out of by the queue. */
export type SettledRunStatus = Exclude<RunStatus, LiveRunStatus>;

/** Is the queue still going to act on this run? */
export function isLiveRunStatus(status: RunStatus): status is LiveRunStatus {
  return LIVE_RUN_STATUSES.some((live) => live === status);
}

/**
 * A settled run the queue strip keeps carrying until a human clears it.
 *
 * A failed or cancelled run creates no content item, so if its strip entry
 * vanished on its own the outcome would be invisible everywhere; a human
 * dismissing it is the acknowledgement. This is the second arm of the `open`
 * filter, and it used to be a second literal inside the same query as the
 * first.
 */
export const DISMISSABLE_RUN_STATUSES = [
  "failed",
  "cancelled",
] as const satisfies readonly SettledRunStatus[];
export type DismissableRunStatus = (typeof DISMISSABLE_RUN_STATUSES)[number];

/**
 * A settled run the strip does NOT carry: it finished and left a draft behind,
 * so the draft is where the reader looks.
 */
const OFF_STRIP_RUN_STATUSES = ["succeeded"] as const satisfies readonly SettledRunStatus[];

/**
 * EVERY RUN STATUS IS CLASSIFIED ABOVE, AND THIS LINE IS WHAT SAYS SO.
 *
 * The three sets are spelled independently on purpose — derive one of them from
 * the other two and this assertion becomes a tautology, which is precisely the
 * kind of guard that reads as protection and protects nothing. As written, a
 * status added to `RUN_STATUSES` and classified nowhere makes the annotation
 * below resolve to that status's own literal type, so `= true` stops compiling
 * with the missing member named in the error:
 *
 *   Type 'true' is not assignable to type '"awaiting_review"'.
 *
 * That is the FIRST of the compile errors a new status has to answer. The rest
 * follow from the sets: `Record<SettledRunStatus, …>` in the api's cancel and
 * dismiss refusals, and `Record<RunStatus, …>` for the web's badge colors.
 */
type UnclassifiedRunStatus = Exclude<
  RunStatus,
  LiveRunStatus | DismissableRunStatus | (typeof OFF_STRIP_RUN_STATUSES)[number]
>;
const _everyRunStatusIsClassified: [UnclassifiedRunStatus] extends [never]
  ? true
  : UnclassifiedRunStatus = true;
void _everyRunStatusIsClassified;

/**
 * Upper bound on the brief a run is started from. Deliberately smaller than
 * `MAX_BODY_LENGTH` (4096, the cap on the text a post actually carries): a
 * brief is an instruction to the model, not the draft, and every character of
 * it is paid for on every one of the run's model calls. A bound the user can
 * see beats a provider-side context error they cannot.
 */
export const MAX_BRIEF_LENGTH = 2000;

/**
 * How many runs one org may have in `queued | running` at once.
 *
 * Exported rather than inlined in the 409 message because the web app names the
 * same number in the empty/blocked state, and a second hand-maintained copy of
 * a limit is how the UI ends up promising a different rule than the API
 * enforces.
 *
 * This is a SPEND guard, not politeness. `GENERATE_WORK_OPTIONS`'s
 * `groupConcurrency: 1` already serialises one org's runs, but serialising is
 * not bounding: fifty queued runs still cost fifty runs' worth of tokens, and
 * the fiftieth sits for hours behind a 30-minute head. Only refusing to admit
 * the fourth actually caps the bill.
 */
export const MAX_CONCURRENT_RUNS = 3;

/**
 * What the fact-checking step's output is called, everywhere a human can read it.
 *
 * It lives here, in the package both the AI steps and the web app depend on, for
 * the same reason `MAX_CONCURRENT_RUNS` does: `@pubrick/ai` puts this exact
 * phrase into the step's own instructions ("the list is shown to that person
 * under the heading …") and `apps/web` prints it as the step's name in the run
 * checklist. Two hand-written copies of it is how the UI ends up promising a
 * check the step never performs — the one thing this step's honesty depends on.
 *
 * The English UI label is pinned to this constant, case-insensitively, by
 * `apps/web/src/test/factcheck-label.test.ts`; the phrase is sentence-cased for
 * display and lowercase here because it also appears mid-sentence in a prompt.
 * `es`/`ru`/`pt` are translations OF the English label and cannot be pinned by
 * string equality — what holds them is `messages-parity` plus the rule that no
 * string in any language may suggest a check happened.
 */
export const CLAIMS_TO_VERIFY_LABEL = "claims to verify";

/**
 * Starting a run. `channelIds` mirrors `contentCreateSchema` exactly —
 * `.min(1)`, `.max(20)` — and that lower bound is load-bearing rather than
 * defensive: a run with no channels reaches its terminal write and produces a
 * content item with ZERO adaptations, which `approve` would happily mark
 * approved while enqueueing nothing at all. The API refuses it up front (400)
 * instead, the same inline error the compose screen already enforces for
 * "Create post".
 */
export const runCreateSchema = z.object({
  brandId: z.string().uuid(),
  brief: z.string().min(1).max(MAX_BRIEF_LENGTH),
  channelIds: z
    .array(z.string().uuid())
    .min(1)
    .max(20)
    // Duplicates are rejected rather than quietly deduped, and NOT because a
    // repeat would be billed twice — it would not. The worker re-reads the fan-
    // out from the database (`GenerateRepository.context`, `id in (…)`), so a
    // channel named twice is adapted once, paid for once, and produces one
    // adaptation under one `adapter:<channelId>` checkpoint.
    //
    // What a duplicate corrupts is the run's own record of what it was asked
    // for, which is not only decoration: the run screen counts the adapter
    // step's progress out of `input.channelIds` (`runStepStates`), so a run
    // admitted with three ids naming two channels reports "3 of 3 channels"
    // over a draft that has two adaptations — a receipt that disagrees with
    // what was produced, on the screen whose whole job is to say what happened.
    // Refusing it here keeps the recorded list and the fan-out the same list.
    //
    // This schema is the only thing catching it on THIS path: `resolveChannels`
    // checks that every id belongs to the brand (set membership), never how many
    // there are. `contentCreateSchema` now carries the same refine — it used to
    // rely on its repository comparing the resolved channel count against the
    // requested one, which caught the duplicate by accident and then reported it
    // as "one or more channels do not belong to this brand", naming the wrong
    // fault.
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "channelIds must not contain duplicates",
    }),
});
export type RunCreate = z.infer<typeof runCreateSchema>;

/**
 * `GET /api/runs?state=…`.
 *
 * `state` is deliberately NOT a member of the run status enum. The content list
 * 400s an unknown `status` by design, so a runs repository copying that pattern
 * would reject `open` as a fake enum member — and `open` is not a status
 * anyway: it spans three of them plus a `dismissed_at` predicate.
 *
 * - `open` — what the queue strip polls: `queued`, `running`, and `failed` or
 *   `cancelled` that nobody has dismissed yet. A failed run creates no content
 *   item, so if its strip vanished the failure would be invisible everywhere.
 * - `all` — every run of the org, for a history view.
 */
export const RUN_LIST_STATES = ["open", "all"] as const;
export type RunListState = (typeof RUN_LIST_STATES)[number];

/**
 * Why a run failed — a closed set of codes, never a sentence.
 *
 * This is `AI_TEST_FAILURES`' rule applied to the other place a provider can
 * talk to a browser, and it is the same rule for the same two reasons. A
 * provider's own error text is NEVER passed through: OpenAI-style bodies quote
 * the submitted credential back ("Incorrect API key provided: sk-live-…") and
 * Google's quota errors quote the request URL, which carries `?key=`. The
 * worker writes this value into `pipeline_runs.error`, `RUN_COLUMNS` returns it
 * on the run list and the run detail, and the queue strip and the run receipt
 * print it — so the only safe contract is one that cannot express a secret
 * however the provider words its 401. A code is also the only way those two
 * screens can speak the four languages this product ships; the provider's
 * English never could.
 *
 * The prose is not lost, it is moved: the worker logs the provider's own
 * sentence, redacted, where an operator can read it and a browser cannot.
 *
 * Members, and what each one is for:
 * - `cancelled` — the model call was abandoned before it answered.
 * - `every_channel_deleted` — every channel the run was started for is gone.
 * - `internal` — a failure of ours, not the provider's: a dropped database
 *   connection, a run input this worker cannot execute, a bug. The generic
 *   member on purpose, so an unrecognised failure degrades to "we do not know"
 *   rather than to a sentence that guesses.
 * - `invalid_key` — the provider rejected the key (401/403).
 * - `model_not_found` — the provider does not know the configured model (404).
 * - `no_api_key` — the org has no AI key stored at all.
 * - `no_structured_output` — the model answered, twice, with something that is
 *   not the structure the step requires.
 * - `provider_refused` — any other refusal that carries an HTTP status.
 * - `rate_limited` — a retryable provider error. Written WITHOUT a terminal
 *   status while the job keeps retrying, so the strip can say why a run is
 *   taking so long.
 * - `retries_exhausted` — the queue gave up; no permanent error ever fired.
 * - `timed_out` — OUR OWN call budget ran out before the provider answered
 *   (`MODEL_CALL_TIMEOUT_MS`). Deliberately not folded into any of its
 *   neighbours, and each fold would have been a different lie: `cancelled`
 *   names an action the user did not take, `rate_limited` blames a provider
 *   that never said it was busy, and `internal` — what it was reported as
 *   between the budget landing on 2026-09-02 and this member existing — hides
 *   the one fact the reader can act on, which is that the call was abandoned
 *   rather than answered. It is also the only failure whose row may have been
 *   billed in full without ever being delivered, which is why the ledger writes
 *   `outcome = 'unknown'` for it and the org's total says "≥".
 * - `too_long_for_channel` — the model could not fit a channel's length limit,
 *   twice. The channel is deliberately not named: a code carries no arguments,
 *   and the receipt's adapter row already shows which channels finished.
 * - `unreadable_key` — the stored key would not decrypt.
 */
export const RUN_FAILURES = [
  "cancelled",
  "every_channel_deleted",
  "internal",
  "invalid_key",
  "model_not_found",
  "no_api_key",
  "no_structured_output",
  "provider_refused",
  "rate_limited",
  "retries_exhausted",
  "timed_out",
  "too_long_for_channel",
  "unreadable_key",
] as const;
export type RunFailure = (typeof RUN_FAILURES)[number];

/** Is this string one of the codes? Guards a value read back out of the database. */
export function isRunFailure(value: unknown): value is RunFailure {
  return typeof value === "string" && (RUN_FAILURES as readonly string[]).includes(value);
}

/**
 * WHAT A RUN WAS ASKED TO PRODUCE — `pipeline_runs.input`, as ONE schema.
 *
 * A jsonb column has no shape the database can check, so its shape is whatever
 * the last writer put there. This column had three descriptions of it: a
 * hand-written type on the drizzle `$type<>()`, an identical hand-written copy
 * in the web, and the worker's zod parse — and only the parse could notice a
 * change, at runtime, on one row at a time. Now the type IS the parse's
 * inference, so the column, the browser and the worker cannot describe it
 * differently.
 *
 * `kind` is discriminated from the start so a watched source can add
 * `"topic"` without a migration.
 */
export const briefRunInputSchema = z.object({
  kind: z.literal("brief"),
  text: z.string().min(1),
  channelIds: z.array(z.string().uuid()).min(1),
});
export type BriefRunInput = z.infer<typeof briefRunInputSchema>;

/**
 * Everything the column may hold — one member today.
 *
 * Kept as a separate name from `briefRunInputSchema` because the two answer
 * different questions the day a second `kind` exists: this one is "what may be
 * stored", and the brief member is "what THIS worker build can execute". The
 * worker parses with the member, so a `topic` run reaching a build that cannot
 * run one fails the run with a sentence instead of being accepted and then
 * crashing inside a step.
 */
export const runInputSchema = briefRunInputSchema;
export type RunInput = z.infer<typeof runInputSchema>;

/**
 * ONE ENTRY PER FINISHED STEP of a run — `pipeline_runs.steps`, as ONE schema.
 *
 * Keyed `researcher | writer | editor | factcheck` or `adapter:<channelId>` — a
 * single `adapter` key would make a crash mid-fan-out re-run every channel that
 * already succeeded, which is the exact re-spend checkpoints exist to prevent.
 * A key's presence means "skip on resume".
 *
 * `failed` IS a member even though no writer produces one today. It is what the
 * COLUMN may contain — the web's run receipt already renders a failed step from
 * it — and narrowing the stored shape to the one arm the current worker writes
 * would delete a reader's branch on the strength of today's writer. The writer's
 * own narrower shape is derived from this one in `apps/worker` rather than
 * declared beside it, so the two cannot describe different columns.
 *
 * `output` and `usage` are `unknown` because they are jsonb inside jsonb: their
 * shape is whatever the worker build that wrote them produced, and every reader
 * narrows before using them.
 */
export const runStepCheckpointSchema = z.object({
  status: z.enum(["succeeded", "failed"]),
  output: z.unknown().optional(),
  usage: z.unknown().optional(),
  finishedAt: z.string().optional(),
});
export type RunStepCheckpoint = z.infer<typeof runStepCheckpointSchema>;

/** The checkpoint map exactly as the column holds it. */
export const runStepsSchema = z.record(z.string(), runStepCheckpointSchema);
export type RunSteps = z.infer<typeof runStepsSchema>;

/**
 * A RUN AS THE API HANDS IT TO A BROWSER — `GET /api/runs` (one element) and,
 * with `steps`, `GET /api/runs/:id`.
 *
 * This is the WIRE shape, after JSON: timestamps are strings, and every column
 * the api's allowlist (`RUN_COLUMNS` in `apps/api`) selects appears here by
 * the name the allowlist gives it. It exists so that the two ends of the wire
 * can be held to ONE declaration: the api's e2e parses a real response body
 * with it, and the web builds its receipt fixtures through it — so a column
 * that the allowlist stops returning fails a parse on both sides, instead of
 * arriving in the browser as `undefined` and rendering as nothing.
 *
 * That is precisely how `unrecordedCalls` spent a day unread. The worker
 * counted, on the run row, every billed model call the ledger refused; nothing
 * selected the column, nothing typed it, and three comments described a receipt
 * that did not exist. A field on this schema is a field the api MUST return.
 *
 * `errorCode` is `string`, not `RunFailure`: rows written before the codes
 * existed still hold prose, and `runFailureMessage` in the web is the thing
 * that decides what a reader sees — see `RUN_FAILURES`.
 */
export const runDtoSchema = z.object({
  id: z.string().uuid(),
  brandId: z.string().uuid(),
  input: runInputSchema,
  status: z.enum(RUN_STATUSES),
  currentStep: z.string().nullable(),
  contentItemId: z.string().uuid().nullable(),
  errorCode: z.string().nullable(),
  dismissedAt: z.string().nullable(),
  /**
   * How many of this run's model calls were billed and could NOT be written to
   * the usage ledger — `pipeline_runs.unrecorded_calls`, as the worker counts
   * it (`GenerateRepository.recordUnrecordedCall`, `+ 1` in SQL per loss).
   *
   * THREE values, and a reader must say a different thing for each:
   * - `n > 0` — n calls cost money that appears in no total. The receipt says
   *   so, and the org's spend figure counts them among the calls it cannot
   *   price (`AiCredentialsRepository.spend`).
   * - `0` — every call on this run reached the ledger. Nothing to say.
   * - `null` — NOT zero. The run predates the counter (migration 0013), so a
   *   loss on it went to a log line and nowhere else; nothing is known, and a
   *   receipt that rendered this the way it renders 0 would be asserting
   *   "nothing was lost" about the one kind of run where a loss could not be
   *   seen. Nullable here for that reason, and NEVER `.default(0)`.
   */
  unrecordedCalls: z.number().int().nonnegative().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RunDto = z.infer<typeof runDtoSchema>;

/**
 * The receipt's shape: the same run plus its checkpoint map, which the list
 * deliberately does not carry (each checkpoint holds a step's whole output).
 */
export const runDetailDtoSchema = runDtoSchema.extend({ steps: runStepsSchema });
export type RunDetailDto = z.infer<typeof runDetailDtoSchema>;
