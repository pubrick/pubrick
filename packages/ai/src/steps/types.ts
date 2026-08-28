import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ZodType } from "zod";
import type { AiProvider } from "../provider.js";
import type { UsageSink } from "../usage.js";

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
 * Everything a step needs that does not come from the step before it.
 *
 * `provider` is not in the task brief's sketch but is required: it is the
 * credential's provider, which `usage_ledger.provider` stores as an enum, and a
 * step has no other way to know whose key is paying. Guessing it from the model
 * id is exactly the mistake `generateStructured` documents.
 *
 * `onUsage` is per-step on purpose: the ledger row carries `step` and, for the
 * adapter, `channelId`, and only the caller knows the run it belongs to. The run
 * rebuilds the context per step with a sink bound to that step's key.
 */
export type StepContext = {
  brand: StepBrand;
  /** The human's brief. Untrusted input: it reaches the model as `prompt`, never as `instructions`. */
  brief: string;
  model: LanguageModelV4;
  provider: AiProvider;
  onUsage: UsageSink;
};

/**
 * One role in the pipeline.
 *
 * `name` is the checkpoint key the run writes into `pipeline_runs.steps`:
 * `researcher | writer | editor | factcheck`, or `adapter:<channelId>`.
 * `schema` is exposed so callers (and tests) can validate a value without
 * making a model call — the adapter's platform limit lives there.
 */
export type Step<I, O> = {
  name: string;
  schema: ZodType<O>;
  run(ctx: StepContext, input: I): Promise<O>;
};
