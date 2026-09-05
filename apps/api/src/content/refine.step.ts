import { defineStep, type Step, type StepContext } from "@pubrick/ai";
import { MAX_BODY_LENGTH, type RefineVerb, refineVerbSchema } from "@pubrick/shared";
import { z } from "zod";

/**
 * The model's reply to a refine request: a replacement for the selection, and
 * why.
 *
 * `text` is what a later task's `planRefineAccept` (`@pubrick/shared`) reads as
 * `RefineAcceptArgs.proposal` — deciding what an accepted proposal leaves
 * behind needs the level's `ai` version rows, which this step has no database
 * to read, so that computation is the caller's, not this one's. This step's
 * whole job ends at producing the replacement text and a reason for it.
 *
 * `reason` is shown next to the proposal so a person can judge the change
 * rather than gamble on it — the dossier's anti-pattern 6, "every suggestion
 * carries a one-line reason". It comes back in the BRAND's content language,
 * never the reader's UI locale: `instructionsFor` (`@pubrick/ai`) tells the
 * model to write every word of its output in that language, unconditionally,
 * on every step. Showing the reason beside a locale-translated verb label is
 * the honest arrangement; translating the reason itself is a later
 * increment's problem, not this one's to solve by accident.
 *
 * `text` is bounded by `MAX_BODY_LENGTH` because it replaces a slice of
 * `content_items.body`, which `contentUpdateSchema` bounds by the same
 * constant: a reply longer than the whole column cannot be part of a storable
 * body, whatever it is spliced into.
 *
 * THAT IS ALL THIS BOUND DOES, and it is not the merged body's. The merged
 * body is `before + text + after`, a quantity this schema never sees, so a
 * near-full body and a full-length reply both pass here and the merge is
 * refused only at Accept, by `planRefineAccept`'s `too_long` — after the call
 * has been paid for. Closing that gap is the CALLER's and has not been done
 * yet: the route that stages a proposal must measure
 * `body.slice(0, start) + text + body.slice(end)` against `MAX_BODY_LENGTH`
 * itself, before it stages the row, because this step holds neither the body
 * nor the offsets to do it with. Accept's check stays regardless — the body
 * can grow between propose and accept — but it is the second line of defence,
 * not the first, and until the caller has a first one there is no propose-time
 * bound on a merged body at all.
 *
 * `text` is NOT piped through `normalizeNewlines`, unlike every body-bearing
 * request DTO (CLAUDE.md: normalise first, bound second). This is a model
 * output schema, not a writer's input: it is converted to JSON schema and sent
 * to the provider, and a transform is not a thing a JSON schema can carry.
 * `planRefineAccept` normalises the proposal itself before merging, so nothing
 * un-normalised is ever stored as a *body* — but the staged proposal a caller
 * writes and renders beside the draft is this raw string, so that caller
 * normalises before it stores.
 */
/**
 * The one character a model may legally return and this product can never
 * store, refused where every other unusable reply is refused.
 *
 * `"\u0000"` is a valid JSON escape, so a reply carrying one parses, satisfies
 * every length rule above, and reaches the database — where no `text` column
 * can hold it (Postgres `22021`). Before this rule that was a `500` on a call
 * the person had already paid for: no proposal, no sentence, and a supersede
 * that had already deleted the card they were looking at.
 *
 * REFUSED RATHER THAN STRIPPED, and refused HERE. A reply this product cannot
 * store is a reply it cannot use, which is exactly what `generateStructured`'s
 * repair retry is for — the model is shown its own broken output, and a second
 * failure is `refine_failed`, a coded refusal whose sentence is "press again",
 * instead of a 500 nobody can act on. Stripping would cost a caller's memory at
 * every place the model's words are stored — `refine_proposals.proposal`, its
 * `reason`, and the fragment body an Accept files as the evidence that a model
 * wrote those sentences — and a forgotten one is the same 500 again. This
 * schema is the only door those words come through, so it is the only place the
 * rule is total. It also keeps the staged proposal VERBATIM, which is what the
 * row is evidence of; a silently edited proposal is a weaker claim than an
 * honest refusal.
 *
 * The JSON schema sent to the provider cannot express this (no `zod` refinement
 * can), and it does not need to: the check runs on the PARSE, which is what
 * turns it into the schema violation the repair retry already handles.
 */
const noNulByte = (value: string) => !value.includes("\u0000");
const NUL_BYTE_MESSAGE = "must not contain a NUL byte, which no text column can store";

export const refineOutputSchema = z.object({
  text: z.string().min(1).max(MAX_BODY_LENGTH).refine(noNulByte, NUL_BYTE_MESSAGE),
  reason: z.string().min(1).max(200).refine(noNulByte, NUL_BYTE_MESSAGE),
});
export type RefineOutput = z.infer<typeof refineOutputSchema>;

/**
 * What the model needs to propose a replacement for one selection.
 *
 * `before`/`after` are the body's own text on either side of the selection.
 * Together with `selection` they are the whole body, cut at the splice offsets
 * and never overlapping — the model is shown every surrounding word, so it can
 * match voice and avoid repeating a neighbouring line. What it is not shown is
 * a SECOND copy of the selected text: sending the body whole beside the
 * selection would put the selected characters in the material twice, and
 * "reply with a replacement for SELECTION only" would stop being unambiguous.
 * Split this way the selected text appears exactly once, under exactly one
 * label.
 *
 * The caller slices `content_items.body` at the splice offsets it already
 * holds to build these three strings; this step does no offset arithmetic of
 * any kind and knows nothing about where in a larger document they came from.
 */
export type RefineInput = {
  /** The exact text the person selected, verbatim. */
  selection: string;
  /** The body immediately before the selection. May be empty. */
  before: string;
  /** The body immediately after the selection. May be empty. */
  after: string;
};

/**
 * The hard rules every verb shares, appended after its own role lines.
 *
 * The first rule is the one the whole feature depends on rather than a nicety:
 * the caller splices `text` into the body at the selection's own offsets
 * (`planRefineAccept`), so a reply that is the whole post rather than the
 * replacement corrupts the body it is spliced into instead of merely
 * disappointing a reader. "SELECTION" here is not decorative prose — it is the
 * exact label the material below fences the selected text under, so the model
 * can tell which of the three blocks it is being asked to replace.
 */
const COMMON_RULES: readonly string[] = [
  "Reply with a replacement for SELECTION only — never BEFORE, never AFTER, and never the whole post. What you return is spliced into the post exactly where SELECTION was, so it must read as a direct continuation of BEFORE and a lead-in to AFTER.",
  "Do not add a fact, a number, a name or a claim that SELECTION, BEFORE or AFTER do not already contain.",
  "Write the replacement in the same language SELECTION is written in.",
  "Produce:",
  "- text: the replacement for SELECTION, ready to be spliced into the post in its place.",
  "- reason: one short plain-language sentence saying what you changed and why, for the human deciding whether to accept it.",
];

/**
 * The verb set is closed — see `REFINE_VERBS`'s own docstring in
 * `@pubrick/shared` for why a free-text instruction is not this increment's to
 * ship. Each entry is role lines only: no verb writes its own rules about the
 * reply shape, and none may reach for a user-typed instruction, because there
 * is none to reach for.
 *
 * `Record<RefineVerb, …>` rather than a `switch`: a verb added to
 * `REFINE_VERBS` without an entry here is a compile error, not a runtime
 * fall-through to the wrong prose — the same reason
 * `TEST_FAILURE_FOR_RUN_FAILURE` (`ai-credentials.probe.ts`) is a `Record`
 * total over `RunFailure` rather than a chain of `if`s.
 */
const ROLE_LINES: Record<RefineVerb, readonly string[]> = {
  shorten: [
    "You shorten one piece of a social media post without losing what it says.",
    "Cut words that do not earn their place. Every fact and the point SELECTION makes must survive in fewer words.",
  ],
  warmer: [
    "You rewrite one piece of a social media post to sound warmer and more personable.",
    "Warmer is not more casual and it is not longer: keep it fitting the voice already established in BEFORE and AFTER.",
  ],
  punchier: [
    "You rewrite one piece of a social media post to hit harder: sharper, more concrete, more direct.",
    "Do not become aggressive, and do not lose the point SELECTION makes — a punchier sentence that says less is not an improvement.",
  ],
};

/**
 * A refine's context: the base `StepContext`, with `maxRetries` made
 * MANDATORY.
 *
 * Every other step in this product leaves it to the SDK's own default of 2,
 * and for a pipeline run that is right — a run is machine-triggered, its
 * retries are what get it past a blip, and nobody is watching. A refine is the
 * opposite on both counts, and the default is wrong for it in two separate
 * ways. A person is watching a spinner, so real exponential backoff is spent
 * in front of them before they are told a rate limit exists. And a press must
 * not be billed three times: `maxRetries` covers TRANSPORT retries, which are
 * physical round trips, each one metered and charged, on top of the repair
 * retry `generateStructured` runs for a schema violation — so one press at the
 * SDK default can buy up to six.
 *
 * That second half is not merely wasteful, it is what the hourly allowance
 * rests on. The allowance counts `usage_ledger` rows `WHERE step = 'refine'`
 * and takes no lock, on the argument that the overshoot past the limit is the
 * concurrency and not a multiple of it. That argument holds only while one
 * press writes a bounded, small number of rows: at `maxRetries: 0` a press
 * costs at most two (the call, and the repair retry), and a press admitted at
 * 119 leaves the hour at most two rows over. Left at the default, one press
 * can write six, and the overshoot becomes a multiple of the per-press cost.
 *
 * So the caller does not get to forget. Requiring the field HERE, in the
 * context a refine step is annotated with, makes an omission a COMPILE error
 * at the call site rather than a comment nobody reads or a runtime throw after
 * the request was accepted — the same mechanism `Record<RefineVerb, …>` uses
 * below and `StepContext`'s own docstring uses for the brief, which is absent
 * rather than optional for exactly this reason. `defineStep` infers a step's
 * context from its `material` callback's annotation, so annotating that
 * callback with this type is the whole implementation.
 *
 * It requires a NUMBER, not the number `0`. The value is a decision the caller
 * owns — the plan's route sets `0` — and a type that spelled the answer would
 * be pinning the policy in the wrong file. What this type refuses is the
 * caller who never thought about it.
 */
export type RefineContext = StepContext & { maxRetries: number };

/**
 * Build the refine step for one verb.
 *
 * Lives here, in `apps/api`, deliberately not beside the five roles in
 * `packages/ai/src/steps/`: that directory's own docstring says it holds "the
 * five roles a generation run plays", each checkpointed under a pipeline run —
 * and a refine is neither a role in a run nor checkpointed at all. It is a
 * call a person triggers by hand, repeatedly, on their own selection, outside
 * any run. `defineStep` and `Material` were exported from the barrel in
 * `packages/ai/src/steps/index.ts` for exactly this caller, and reaching the
 * SDK any other way would give up the prompt boundary, the schema identity and
 * the ledger attribution that live on that path.
 *
 * Every verb shares one ledger identity, `step: "refine"` — never
 * `` refine:${verb} `` — because the allowance that bounds this call counts
 * `usage_ledger` rows `WHERE step = 'refine'`; splitting the name by verb
 * would let a person multiply the hourly allowance by pressing a different
 * button for the same money. `StepAttribution` carries no `channelId` either:
 * unlike the adapter, this is not per-channel work.
 *
 * Returns a fresh `Step` per call rather than one memoized per verb: a `Step`
 * is a plain object built with no I/O, `defineStep` does no work worth
 * caching, and a shared instance would only invite a caller to hold one across
 * requests for no benefit.
 *
 * `Step<RefineInput, RefineOutput, RefineContext>` — built on the BASE
 * context, not `RunStepContext` — because a refine is not a step in a pipeline
 * run and has no brief to read; see `StepContext`'s own docstring on why that
 * field is absent rather than merely optional. The API's editor-side call is
 * the first caller that context split was made for. `RefineContext` narrows
 * the base in the one direction this call needs it narrowed: `maxRetries` is
 * required, for the reasons on that type.
 */
/**
 * The ledger identity every refine call is attributed with — one string, read
 * by the two places that must agree about it.
 *
 * `defineStep({ name })` writes it into `usage_ledger.step` through
 * `StepAttribution`, and the hourly allowance counts the rows it wrote
 * (`ContentRepository`, `WHERE step = 'refine'`). Spelled out at both ends
 * those are two literals that must match for the limit to bound anything at
 * all: a typo at either end leaves a limit that counts nothing, refuses
 * nobody, and looks exactly like a limit. There is no test that could see it
 * except one that ran a real call and then read the count — which is why the
 * string is declared once and imported.
 *
 * NEVER `` `refine:${verb}` ``. Splitting the name by verb would give each
 * button its own hourly allowance, so a person could spend three times the
 * money by pressing a different one for the same work.
 */
export const REFINE_STEP = "refine";

export function refineStep(verb: RefineVerb): Step<RefineInput, RefineOutput, RefineContext> {
  // Parsed, not trusted. `RefineVerb` is a compile-time guarantee and the
  // caller this step was built for reads its verb off an HTTP body, where the
  // compiler has no say: a route that types `body.verb as RefineVerb`, or that
  // simply has a `string` from a DTO written without `refineVerbSchema`, hands
  // this function a value the type says is one of three and the process says
  // is anything at all. Unparsed, `ROLE_LINES[verb]` is `undefined` and the
  // spread below throws a bare `TypeError` — a 500 on what is a refusal, and
  // one whose message names an implementation detail.
  //
  // It refuses HERE, while building, rather than in `material`: nothing that
  // reaches this line can produce a `Step`, so an off-list verb cannot be run
  // and cannot spend a cent. Prototype keys (`constructor`, `toString`,
  // `__proto__`) are refused by the same parse, which is the reason to parse
  // against the declared set rather than test `verb in ROLE_LINES`.
  const role = ROLE_LINES[refineVerbSchema.parse(verb)];

  return defineStep({
    name: REFINE_STEP,
    schema: refineOutputSchema,
    role: [...role, "", ...COMMON_RULES],
    material: (_ctx: RefineContext, input: RefineInput) => [
      { label: "SELECTION", text: input.selection },
      { label: "BEFORE", text: input.before },
      { label: "AFTER", text: input.after },
    ],
  });
}
