import { PermanentError } from "@pubrick/shared";
import {
  type FlexibleSchema,
  generateText,
  type LanguageModel,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
} from "ai";
import { classifyAiError, withRunFailure } from "./classify.js";
import type { AiProvider } from "./provider.js";
import {
  createCallRecorder,
  type MeteredCall,
  toUsageRecord,
  type UsageRecord,
  type UsageSink,
} from "./usage.js";

/**
 * How long one logical model call gets, in total, before it is abandoned.
 *
 * Two minutes against a structured call on the default model that finishes in
 * seconds — wide enough that no honest generation reaches it, narrow enough to
 * bound what a stuck provider can cost. Until 2026-09-02 there was no bound of
 * ours at all: the only limit was the HTTP client's default of 300 SECONDS per
 * round trip, so one step could sit for the SDK's retries plus the repair
 * retry — six round trips, half an hour — with every one of them possibly
 * billed and none of them visible in the total.
 *
 * TOTAL, not per round trip. The budget is the wall clock of the whole logical
 * call, repair retry included, because it exists to bound what the CALLER
 * waits and what the caller can be charged; a per-round-trip bound multiplies
 * by however many trips the SDK decides to make.
 */
export const MODEL_CALL_TIMEOUT_MS = 120_000;

/**
 * The knobs a model call takes that are not the call itself: how hard to try,
 * where to report a lost ledger row, what time it is, how long to wait, and how
 * to stop.
 *
 * Named as one type because they travel as one set — `StepContext` carries
 * exactly these five so that `callStep` can forward exactly these five. The
 * type keeps the set in step; only the forwarding tests keep it forwarded.
 */
export type ModelCallOptions = {
  /**
   * Called when `onUsage` itself fails. A ledger write that fails must not
   * destroy generated text we have already paid for, so the failure is routed
   * here instead of being thrown; it defaults to a loud log, matching how the
   * publisher reports a delivered post it could not record.
   */
  onUsageError?: (error: unknown, record: UsageRecord) => void;
  /**
   * Transport retries inside a single attempt. The SDK's default (2) is right
   * in production; tests set 0 so a retryable status fails immediately instead
   * of sitting through real exponential backoff.
   *
   * This has nothing to do with the repair retry below: `maxRetries` never sees
   * a schema violation. Every physical call these retries make is metered.
   */
  maxRetries?: number;
  /** Injectable clock, so the price table's effective dates are testable. */
  now?: () => Date;
  /**
   * How long the whole logical call may take before it is abandoned. Defaults
   * to `MODEL_CALL_TIMEOUT_MS`; a caller that knows better may narrow it, and
   * tests set it small to prove the bound exists.
   */
  timeoutMs?: number;
  /**
   * Cancels the call, and is threaded into BOTH attempts — the repair retry
   * re-enters the same path, so a signal given to one and not the other still
   * buys a second call.
   *
   * An abort after dispatch is a charge we cannot see the size of: the provider
   * can have finished the work and started answering when we hung up. The
   * recorder pushes a record per PHYSICAL round trip, so each of those writes a
   * zero-token row — and until 2026-09-02 zero tokens was enough to put it in
   * `cost-display.ts`'s IGNORED bucket, whose premise is that the call cost
   * nothing. True of a 429 the provider rejected before counting anything; not
   * true of this. Those rows now carry `outcome: "unknown"` and are counted as
   * unpriced, so the total says "≥" instead of quietly shrinking.
   *
   * That makes the retry budget a question of money rather than of honesty, but
   * it is still a question: a caller that hands over a signal is still buying up
   * to six round trips per attempt if it leaves `maxRetries` at the SDK's
   * default of two.
   */
  abortSignal?: AbortSignal;
};

export type GenerateStructuredArgs<T> = ModelCallOptions & {
  model: LanguageModel;
  /**
   * Whose key is paying. Taken from the credential rather than parsed out of the
   * SDK's provider id: the ledger column is an enum, and the caller resolved the
   * model from a credential, so it already knows.
   */
  provider: AiProvider;
  schema: FlexibleSchema<T>;
  /**
   * The system half of the prompt: role, brand voice, output rules.
   *
   * v7 rejects system messages inside `prompt`/`messages` by default as
   * prompt-injection hardening, and this separation is the reason. Anything
   * that came from outside — a brief typed by a user, and in a later increment
   * the text of a fetched article — belongs in `prompt`, never here.
   */
  instructions: string;
  prompt: string;
  onUsage: UsageSink;
};

/**
 * Generate a value matching `schema`, metering every physical model call it takes.
 *
 * `generateObject` is deprecated in v7, so structured output goes through
 * `generateText({ output: Output.object({ schema }) })`. That path has **no
 * `repairText` hook** — it exists only on the deprecated API — and it does not
 * retry a schema violation: `maxRetries` covers transport errors only, and a
 * violation throws `NoObjectGeneratedError` straight out. So the repair is
 * ours: one retry that feeds the offending text and the validation message
 * back, then we give up as permanent rather than burn a third call on a model
 * that has now failed the same schema twice.
 *
 * Every round trip the SDK actually made is reported to `onUsage`, including
 * the ones its own retry loop made and the ones that failed. The provider counts
 * tokens before it knows whether we can parse the answer, and money spent with
 * no record is what makes a ledger untrustworthy.
 */
export async function generateStructured<T>(args: GenerateStructuredArgs<T>): Promise<T> {
  const clock = args.now ?? (() => new Date());

  // Started here, not per attempt: the budget is the whole logical call's, so
  // an attempt that burns 110 seconds leaves the repair retry ten and not
  // another two minutes. `AbortSignal.timeout`'s timer does not hold the event
  // loop open, so a call that returns early leaves nothing running behind it.
  const budget = AbortSignal.timeout(args.timeoutMs ?? MODEL_CALL_TIMEOUT_MS);
  // `any`, so the caller's own signal keeps working and each of the two keeps
  // its own abort reason — which is what lets `classifyAiError` tell "someone
  // cancelled this" from "it ran out of time".
  const signal =
    args.abortSignal === undefined ? budget : AbortSignal.any([args.abortSignal, budget]);

  try {
    return await attempt(args, args.prompt, 1, clock, signal);
  } catch (firstError) {
    if (!NoObjectGeneratedError.isInstance(firstError)) throw classifyAiError(firstError);

    // A tool call instead of text is a different failure: there is no offending
    // text to quote back, so a repair prompt would be a guess. See `attempt`.
    let repaired: T;
    try {
      repaired = await attempt(args, repairPrompt(args.prompt, firstError), 2, clock, signal);
    } catch (repairError) {
      if (!NoObjectGeneratedError.isInstance(repairError)) throw classifyAiError(repairError);
      const failure = withRunFailure(
        new PermanentError(
          `the model returned output that does not match the required schema, twice: ${validationMessage(repairError)}`,
        ),
        "no_structured_output",
      );
      // The originating error travels along as `cause`, and callers that need to
      // know WHICH rule was broken must read the validation issues through it.
      // The message above is not a safe substitute: it renders the model's own
      // output verbatim, so a model can write any sentence it likes into it —
      // including one that impersonates a validation failure. The adapter's
      // platform-limit check reads the issues for exactly that reason.
      failure.cause = repairError;
      throw failure;
    }
    return repaired;
  }
}

/**
 * One `generateText` call — which may be several physical round trips — metered.
 *
 * `.output` is read inside the try because that getter is where the tool-call
 * case fails: output resolution runs only for text content, and a response whose
 * content is a tool call skips it entirely, leaving the getter to throw
 * `NoOutputGeneratedError`. Reading it outside would leave that call unmetered.
 */
async function attempt<T>(
  args: GenerateStructuredArgs<T>,
  prompt: string,
  attemptNumber: number,
  clock: () => Date,
  /** The caller's signal and the time budget, already composed. */
  signal: AbortSignal,
): Promise<T> {
  // Before the recorder exists, so a call that never happened leaves no row.
  //
  // The check is ours because the SDK does not make it. Measured against
  // ai@7.0.83: `generateText` hands the signal to the provider and nothing
  // else, so an already-aborted signal still reaches `doGenerate`, and a
  // provider that ignores it answers — and bills — normally. Its own
  // `throwIfAborted` runs only from the SECOND step of a multi-step call
  // onwards, and a structured call has exactly one step.
  //
  // Here rather than at the top of `generateStructured`, because it must guard
  // BOTH attempts: an abort while the first call is in flight must not buy the
  // repair call, and neither must a budget the first call already spent.
  // `throwIfAborted` throws the signal's own reason, which `classifyAiError`
  // turns into the cancellation sentence or the timeout one.
  signal.throwIfAborted();

  const recorder = createCallRecorder(modelIdOf(args.model));

  let value: T;
  try {
    const result = await generateText({
      model: args.model,
      output: Output.object({ schema: args.schema }),
      instructions: args.instructions,
      prompt,
      ...(args.maxRetries === undefined ? {} : { maxRetries: args.maxRetries }),
      // The in-flight half of the same rule: a signal that fires after dispatch
      // has to reach the provider, and this attempt may be either of the two.
      // This is also the ONLY thing that makes the budget a bound on a call
      // already on the wire — without it the timeout could not interrupt the
      // 300-second wait it exists to cut short.
      abortSignal: signal,
      // Per call, never registerTelemetry: the global registry has no
      // unregister, so a sink registered once would outlive its run and leak
      // into the next test file. Per-call integrations replace the global list.
      telemetry: { integrations: recorder.integration },
    });
    value = result.output;
  } catch (error) {
    await report(args, recorder.calls, attemptNumber, "errored", clock);
    if (NoOutputGeneratedError.isInstance(error)) {
      throw withRunFailure(
        new PermanentError(
          "the model produced a tool call instead of text, so no structured output could be read",
        ),
        "no_structured_output",
      );
    }
    throw error;
  }

  // Outside the try: a ledger write that fails must not turn a successful
  // generation into a failed one. We would lose the text we just paid for AND
  // the record of paying for it — strictly worse than losing the record alone.
  await report(args, recorder.calls, attemptNumber, "ok", clock);
  return value;
}

async function report<T>(
  args: GenerateStructuredArgs<T>,
  calls: MeteredCall[],
  attemptNumber: number,
  status: "ok" | "errored",
  clock: () => Date,
): Promise<void> {
  const at = clock();
  for (const call of calls) {
    const record = toUsageRecord(call, {
      provider: args.provider,
      attempt: attemptNumber,
      // A round trip that itself failed is errored even when a later retry
      // rescued the attempt.
      status: call.transportOk ? status : "errored",
      at,
    });
    try {
      await args.onUsage(record);
    } catch (sinkError) {
      reportSinkFailure(args, sinkError, record);
    }
  }
}

function reportSinkFailure<T>(
  args: GenerateStructuredArgs<T>,
  error: unknown,
  record: UsageRecord,
): void {
  if (args.onUsageError !== undefined) {
    args.onUsageError(error, record);
    return;
  }
  console.error(
    `USAGE RECORDING FAILED: a ${record.provider}/${record.modelId} call was billed but could not be written to the ledger — the org's spend is understated by this row. ` +
      `inputTokens=${record.inputTokens} outputTokens=${record.outputTokens} costUsd=${record.costUsd} error=${error instanceof Error ? error.message : String(error)}`,
  );
}

/** The id to attribute a round trip to when the telemetry event omits it. */
function modelIdOf(model: LanguageModel): string {
  return typeof model === "string" ? model : model.modelId;
}

/**
 * The repair prompt.
 *
 * The offending text goes in `prompt`, not `instructions` — it is model output,
 * which is exactly the untrusted-text case the v7 prompt boundary exists for.
 */
function repairPrompt(original: string, error: unknown): string {
  const offending = NoObjectGeneratedError.isInstance(error) ? (error.text ?? "") : "";
  return [
    original,
    "",
    "Your previous reply could not be read as the required JSON value.",
    "",
    "Previous reply:",
    offending,
    "",
    "What was wrong with it:",
    validationMessage(error),
    "",
    "Reply again with the corrected JSON value only. Do not explain the fix.",
  ].join("\n");
}

function validationMessage(error: unknown): string {
  if (NoObjectGeneratedError.isInstance(error) && error.cause instanceof Error) {
    return error.cause.message;
  }
  return error instanceof Error ? error.message : String(error);
}
