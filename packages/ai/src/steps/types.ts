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
 * Everything a step needs that does not come from the step before it.
 *
 * `provider` is not in the task brief's sketch but is required: it is the
 * credential's provider, which `usage_ledger.provider` stores as an enum, and a
 * step has no other way to know whose key is paying. Guessing it from the model
 * id is exactly the mistake `generateStructured` documents.
 *
 * One context can safely serve a whole run: nothing in it is step-specific,
 * because the step's identity travels with the usage record instead.
 */
export type StepContext = {
  brand: StepBrand;
  /** The human's brief. Untrusted input: it reaches the model as `prompt`, never as `instructions`. */
  brief: string;
  model: LanguageModelV4;
  provider: AiProvider;
  onUsage: StepUsageSink;
};

/**
 * One role in the pipeline.
 *
 * `name` is the checkpoint key the run writes into `pipeline_runs.steps`:
 * `researcher | writer | editor | factcheck`, or `adapter:<channelId>`.
 * `schema` is the very schema `run` sends to the model — `defineStep` uses one
 * reference for both — so validating a value against it here says something
 * true about what the model was asked for.
 */
export type Step<I, O> = {
  name: string;
  schema: ZodType<O>;
  run(ctx: StepContext, input: I): Promise<O>;
};
