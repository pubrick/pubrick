import { PermanentError } from "@pubrick/shared";
import {
  type FlexibleSchema,
  generateText,
  type LanguageModel,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
} from "ai";
import { classifyAiError } from "./classify.js";
import type { AiProvider } from "./provider.js";
import {
  createCallRecorder,
  type MeteredCall,
  toUsageRecord,
  type UsageRecord,
  type UsageSink,
} from "./usage.js";

export type GenerateStructuredArgs<T> = {
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

  try {
    return await attempt(args, args.prompt, 1, clock);
  } catch (firstError) {
    if (!NoObjectGeneratedError.isInstance(firstError)) throw classifyAiError(firstError);

    // A tool call instead of text is a different failure: there is no offending
    // text to quote back, so a repair prompt would be a guess. See `attempt`.
    let repaired: T;
    try {
      repaired = await attempt(args, repairPrompt(args.prompt, firstError), 2, clock);
    } catch (repairError) {
      if (!NoObjectGeneratedError.isInstance(repairError)) throw classifyAiError(repairError);
      throw new PermanentError(
        `the model returned output that does not match the required schema, twice: ${validationMessage(repairError)}`,
      );
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
): Promise<T> {
  const recorder = createCallRecorder(modelIdOf(args.model));

  let value: T;
  try {
    const result = await generateText({
      model: args.model,
      output: Output.object({ schema: args.schema }),
      instructions: args.instructions,
      prompt,
      ...(args.maxRetries === undefined ? {} : { maxRetries: args.maxRetries }),
      // Per call, never registerTelemetry: the global registry has no
      // unregister, so a sink registered once would outlive its run and leak
      // into the next test file. Per-call integrations replace the global list.
      telemetry: { integrations: recorder.integration },
    });
    value = result.output;
  } catch (error) {
    await report(args, recorder.calls, attemptNumber, "errored", clock);
    if (NoOutputGeneratedError.isInstance(error)) {
      throw new PermanentError(
        "the model produced a tool call instead of text, so no structured output could be read",
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
