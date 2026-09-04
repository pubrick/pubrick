import { defineStep, type Step, type StepContext } from "@pubrick/ai";
import { MAX_BODY_LENGTH, type RefineVerb } from "@pubrick/shared";
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
 * `text` is bounded by `MAX_BODY_LENGTH` for the same reason the writer's and
 * editor's bodies are: it replaces a slice of `content_items.body`, which
 * `contentUpdateSchema` bounds by the same constant, and a merged body over
 * that limit would be un-storable — closed at *propose* time here, and
 * re-checked at *accept* time by `planRefineAccept` because the body can grow
 * between the two.
 */
export const refineOutputSchema = z.object({
  text: z.string().min(1).max(MAX_BODY_LENGTH),
  reason: z.string().min(1).max(200),
});
export type RefineOutput = z.infer<typeof refineOutputSchema>;

/**
 * What the model needs to propose a replacement for one selection.
 *
 * `before`/`after` are the body's own text immediately surrounding the
 * selection — not the whole body it was cut from — so the model can match
 * voice and avoid repeating a neighbouring line without being handed a second
 * copy of `selection` sitting inside a fourth block it would have to find for
 * itself. Splitting the surrounding text this way is also what keeps "reply
 * with a replacement for SELECTION only" unambiguous: the selected text
 * appears in the material exactly once, under exactly one label.
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
 * `Step<RefineInput, RefineOutput, StepContext>` — the BASE context, not
 * `RunStepContext` — because a refine is not a step in a pipeline run and has
 * no brief to read; see `StepContext`'s own docstring on why that field is
 * absent rather than merely optional. The API's editor-side call is the first
 * caller that context split was made for.
 */
export function refineStep(verb: RefineVerb): Step<RefineInput, RefineOutput, StepContext> {
  return defineStep({
    name: "refine",
    schema: refineOutputSchema,
    role: [...ROLE_LINES[verb], "", ...COMMON_RULES],
    material: (_ctx, input) => [
      { label: "SELECTION", text: input.selection },
      { label: "BEFORE", text: input.before },
      { label: "AFTER", text: input.after },
    ],
  });
}
