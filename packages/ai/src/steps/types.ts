import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ZodType } from "zod";
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
 */
export type StepContext = {
  brand: StepBrand;
  model: LanguageModelV4;
  provider: AiProvider;
  onUsage: StepUsageSink;
};

/**
 * What a pipeline run additionally has: the brief the run was started from.
 *
 * A step that needs a brief is typed against THIS, so it still cannot be built
 * or called without one — the guarantee the required field used to give, kept
 * for the steps it is true of and dropped for the ones it never was.
 */
export type RunStepContext = StepContext & {
  /** The human's brief. Untrusted input: it reaches the model as `prompt`, never as `instructions`. */
  brief: string;
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
