import { z } from "zod";

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
  "too_long_for_channel",
  "unreadable_key",
] as const;
export type RunFailure = (typeof RUN_FAILURES)[number];

/** Is this string one of the codes? Guards a value read back out of the database. */
export function isRunFailure(value: unknown): value is RunFailure {
  return typeof value === "string" && (RUN_FAILURES as readonly string[]).includes(value);
}
