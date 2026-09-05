import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ZodType } from "zod";
import type { ModelCallOptions } from "../generate.js";
import type { AiProvider } from "../provider.js";
import type { UsageRecord } from "../usage.js";

/**
 * The brand a run writes for, in the shape a step needs it.
 *
 * Deliberately not the drizzle row: `packages/ai` has no database dependency
 * and must not grow one. `voice` and `audience` are nullable in that table and
 * stay nullable here — an unset voice omits its line rather than telling the
 * model the voice is "null".
 */
export type StepBrand = {
  name: string;
  voice: string | null;
  audience: string | null;
  /** BCP-47-ish code as stored on the brand (`brandCreateSchema` defaults it to `en`). */
  contentLanguage: string;
};

/**
 * Which step a ledger row belongs to.
 *
 * Supplied by the step itself, never by the caller: `usage_ledger.step` and
 * `channel_id` are what make a row attributable, and a run that built one
 * context and reused it across steps would write rows whose tokens, cost and
 * status all looked right while every one of them named the wrong step.
 */
export type StepAttribution = { step: string; channelId?: string };

/**
 * Where a step's ledger rows go.
 *
 * Wider than `UsageSink` by exactly the attribution the caller cannot know and
 * the step cannot get wrong. The run adds `orgId` and `runId`, which this
 * package has no way to know.
 */
export type StepUsageSink = (
  record: UsageRecord,
  attribution: StepAttribution,
) => Promise<void> | void;

/**
 * Everything a step needs that does not come from the step before it — and that
 * EVERY caller of a step can supply.
 *
 * `provider` is not in the task brief's sketch but is required: it is the
 * credential's provider, which `usage_ledger.provider` stores as an enum, and a
 * step has no other way to know whose key is paying. Guessing it from the model
 * id is exactly the mistake `generateStructured` documents.
 *
 * One context can safely serve a whole run: nothing in it is step-specific,
 * because the step's identity travels with the usage record instead.
 *
 * The brief is deliberately NOT here. A caller outside a pipeline run — the
 * API's editor-side call is the first — has no brief and no honest value to
 * invent for one. Making the field optional would only move the problem: three
 * steps read it as material text, `string | undefined` is a compile error in
 * each of them, and the obvious repair is `?? ""` in three places. An empty
 * brief is exactly the value a later reader mistakes for a real one.
 *
 * `ModelCallOptions` is the same four knobs `generateStructured` takes —
 * `maxRetries`, `onUsageError`, `now`, `abortSignal` — and `callStep` forwards
 * every one of them. They belong to the caller and not to the step: how many
 * retries a call is worth, and whether it can still be cancelled, are questions
 * only the thing that started it can answer. Three of the four were dropped on
 * the way through until 2026-09-02, so no step could be bounded at all.
 */
export type StepContext = ModelCallOptions & {
  brand: StepBrand;
  model: LanguageModelV4;
  provider: AiProvider;
  onUsage: StepUsageSink;
};

/**
 * What a pipeline run additionally has: the words the run was started from —
 * a brief someone typed, material someone pasted, or both.
 *
 * A step that needs them is typed against THIS, so it still cannot be built or
 * called without them — the guarantee the required field used to give, kept for
 * the steps it is true of and dropped for the ones it never was.
 *
 * ALL THREE ARE REQUIRED AND NULLABLE, never optional, and the reason is the
 * one `StepContext` gives above for leaving the brief off altogether: three
 * steps read these as material text, `string | undefined` is a compile error in
 * each of them, and the obvious repair is `?? ""` in three places. Required
 * makes every builder of this context NAME a value, so a caller with no
 * material says so rather than inheriting an absence.
 *
 * That is a compile-time guarantee only, and the three closures know it: vitest
 * strips types, so a spec that was never updated runs with `undefined` here.
 * The blocks are therefore emitted on `!= null` (loose), which covers both.
 *
 * "OR BOTH" IS NOT "OR NEITHER", AND THE TYPE CANNOT SAY SO. Two independently
 * nullable members permit a context with neither, which builds an empty block
 * list and buys a model call whose user message is the empty string — billed,
 * answered from the role lines alone, and checkpointed as if it had worked.
 * Until this type existed, `brief: string` made "at least one block" a fact the
 * compiler enforced. A union here (`{brief: string; material: null} | …`) would
 * restore the compile-time half and only that half, which is exactly the half
 * that a stripped spec, a JS caller and a jsonb checkpoint all walk past — the
 * reason the predicates above are loose in the first place. So the invariant is
 * kept where it can refuse: `callStep` throws a `PermanentError` on an empty
 * block list before the provider is reached, for every step rather than these
 * three, and for emptiness that comes from a step's INPUT as readily as from
 * its context.
 */
export type RunStepContext = StepContext & {
  /**
   * The human's brief, or `null` when they pasted material instead of writing
   * one. Untrusted input: it reaches the model as `prompt`, never as
   * `instructions`.
   *
   * `null` and never `""`. An empty labelled BRIEF block tells the model the
   * person wrote nothing USEFUL rather than that they wrote nothing, and it
   * says it on three paid calls in a row. `runs.repository.create` blanks the
   * `""` the compose screen sends unconditionally, and the three steps hold the
   * same line themselves — a blank value emits no block, the way an unset brand
   * voice omits its line. That is a decision about PRESENCE only: no step
   * rewrites the text it was given, so no prompt can differ from the receipt
   * the run screen shows.
   */
  brief: string | null;
  /**
   * Article text a person pasted, or `null`. Untrusted for the reason the brief
   * is and then some: these are a stranger's words, reaching the model as
   * `prompt` and never as `instructions`.
   */
  material: string | null;
  /**
   * Where the material came from — recorded, never fetched, and NEVER emitted
   * into a block by any step.
   *
   * It is on the context so that no step can be given the material without also
   * being able to see that a URL was recorded; it is kept out of the prompt
   * because a URL invites the model to write as though it had read the page,
   * and nothing in this product ever did.
   */
  sourceUrl: string | null;
};

/**
 * One role in the pipeline.
 *
 * `name` is the checkpoint key the run writes into `pipeline_runs.steps`:
 * `researcher | writer | editor | factcheck`, or `adapter:<channelId>`.
 * `schema` is the very schema `run` sends to the model — `defineStep` uses one
 * reference for both — so validating a value against it here says something
 * true about what the model was asked for.
 *
 * `C` is what this step's `run` demands of its caller, and it DEFAULTS to the
 * base `StepContext`: a new step gets no brief in scope unless it says it needs
 * one, so reaching for `ctx.brief` without declaring `RunStepContext` does not
 * compile.
 */
export type Step<I, O, C extends StepContext = StepContext> = {
  name: string;
  schema: ZodType<O>;
  /**
   * A PROPERTY holding a function, never a method. Method parameters are
   * compared bivariantly even under `strictFunctionTypes`, which would let a
   * `Step<I, O, RunStepContext>` pass anywhere a `Step<I, O, StepContext>` is
   * wanted and then be handed a context with no brief — the one substitution
   * this split exists to forbid. Written this way the assignability runs one
   * way only: a step needing nothing but the base context can serve a caller
   * that has a brief, and not the reverse.
   */
  run: (ctx: C, input: I) => Promise<O>;
};
