import { PermanentError, TransientError } from "@pubrick/shared";
import { APICallError, RetryError } from "ai";

/**
 * How many `RetryError` wrappers to unwrap before giving up. The SDK nests one
 * level today; the loop is bounded so a future change cannot spin here.
 */
const MAX_UNWRAP_DEPTH = 5;

/**
 * Reduce an unknown thrown value to the two error classes the job queue
 * understands.
 *
 * The decision is the SDK's own, not a status-code list of ours:
 * `APICallError.isInstance(e) && e.isRetryable === true`. `isRetryable`
 * defaults to 408 / 409 / 429 / >=500, and a provider that knows better can
 * override it. Keeping our own copy of that list would drift.
 *
 * Always `APICallError.isInstance`, never `instanceof`: the marker symbol
 * survives duplicate copies of `@ai-sdk/provider` in the tree, and `instanceof`
 * does not.
 *
 * Everything else is permanent — schema violations, bad prompts,
 * `LoadAPIKeyError`, a provider 401. Retrying those spends money to fail again.
 */
export function classifyAiError(error: unknown): PermanentError | TransientError {
  // Already classified upstream (the repair wrapper throws PermanentError).
  if (error instanceof PermanentError || error instanceof TransientError) return error;

  const cause = unwrapRetry(error);

  if (APICallError.isInstance(cause) && cause.isRetryable === true) {
    return new TransientError(cause.message, retryAfterSeconds(cause.responseHeaders));
  }

  if (APICallError.isInstance(cause)) {
    return new PermanentError(cause.message, cause.statusCode);
  }

  return new PermanentError(messageOf(cause));
}

/**
 * `RetryError` is what the SDK throws once its own transport retries are
 * exhausted; the interesting error is the last one it saw.
 */
function unwrapRetry(error: unknown): unknown {
  let current = error;
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth += 1) {
    if (!RetryError.isInstance(current)) return current;
    const last: unknown = current.lastError;
    if (last === undefined || last === null) return current;
    current = last;
  }
  return current;
}

/**
 * Backoff hint. HTTP headers are case-insensitive but the SDK hands them to us
 * as a plain object with lowercase keys, so lowercase is what we read.
 * `retry-after-ms` is the millisecond variant several providers send.
 */
function retryAfterSeconds(headers: Record<string, string> | undefined): number | undefined {
  if (headers === undefined) return undefined;

  const ms = Number(headers["retry-after-ms"]);
  if (Number.isFinite(ms) && ms > 0) return Math.ceil(ms / 1000);

  const raw = headers["retry-after"];
  if (raw === undefined) return undefined;

  // Seconds form.
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);

  // HTTP-date form.
  const at = Date.parse(raw);
  if (!Number.isNaN(at)) return Math.max(0, Math.ceil((at - Date.now()) / 1000));

  return undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
