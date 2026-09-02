import { isRunFailure, PermanentError, type RunFailure, TransientError } from "@pubrick/shared";
import { APICallError, RetryError } from "ai";

/**
 * How many `RetryError` wrappers to unwrap before giving up. The SDK nests one
 * level today; the loop is bounded so a future change cannot spin here.
 */
const MAX_UNWRAP_DEPTH = 5;

/**
 * The property a classified error carries its closed failure code on.
 *
 * A field rather than the message, because the two have different audiences.
 * The CODE is what the worker stores and a browser is shown, in four languages;
 * the MESSAGE stays the provider's own sentence, which is the most informative
 * thing available and is also where a key can hide — it belongs in a log, and
 * `redactSecrets` is what makes it fit to appear even there.
 *
 * Read through `runFailureOf`, which re-validates against `RUN_FAILURES` rather
 * than trusting the property: an error can cross a package boundary from a
 * duplicate copy of `@pubrick/ai` in the tree, and the same marker-symbol
 * reasoning that makes us prefer `APICallError.isInstance` over `instanceof`
 * applies to a value we merely hung on an object.
 */
type FailureCarrier = { runFailure?: unknown };

/** Tag a classified error with the code the run row will store. */
export function withRunFailure<E extends Error>(error: E, failure: RunFailure): E {
  (error as E & FailureCarrier).runFailure = failure;
  return error;
}

/** The code an error was tagged with, if it is one of ours and one of the codes. */
export function runFailureOf(error: unknown): RunFailure | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const tagged = (error as FailureCarrier).runFailure;
  return isRunFailure(tagged) ? tagged : undefined;
}

/**
 * Reduce an unknown thrown value to the two error classes the job queue
 * understands, TAGGED with the closed code that reaches the user.
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
 *
 * The status → code mapping is deliberately the SAME one `classifyProbeFailure`
 * makes for the Test button (401/403 invalid, 404 unknown model, anything else
 * with a status refused), so a key that fails a run and a key that fails the
 * Test are described to the user in the same words.
 */
export function classifyAiError(error: unknown): PermanentError | TransientError {
  // Already classified upstream (the repair wrapper throws PermanentError).
  // It carries its own tag; re-tagging here would overwrite what the throw site
  // knew with what this function can only guess.
  if (error instanceof PermanentError || error instanceof TransientError) return error;

  const cause = unwrapRetry(error);

  // Permanent, and a code of its own. A cancelled call is not a failure the
  // provider had anything to do with, so it is not an `APICallError` and used
  // to fall through to the bare branch below — which would show a user the
  // DOM's own words, "This operation was aborted": true, and about nothing they
  // recognise as having done. Permanent rather than transient because nobody is
  // waiting for the answer any more; a retry would spend money on a result the
  // caller has already withdrawn its request for.
  if (isAbortError(cause)) return withRunFailure(new PermanentError(CANCELLED), "cancelled");

  // Our own budget ran out (see `MODEL_CALL_TIMEOUT_MS`). Distinguished from
  // the abort above by name, because `AbortSignal.timeout()` aborts with a
  // `TimeoutError` and nobody asked for it — telling a user their call was
  // "cancelled" would name an action they did not take.
  //
  // TRANSIENT, and the choice is not free. A retry may pay again for a call the
  // provider already billed, which is the argument the abort branch above uses
  // for being permanent. It goes the other way here because the caller has not
  // withdrawn anything: a stuck provider is the ordinary reason to hit this,
  // every finished step is checkpointed so only the timed-out step re-runs, and
  // the alternative — one 121-second generation killing a run for good — is a
  // worse failure than a second attempt. What made the old behaviour dangerous
  // was not the retry but its invisibility; the round trip now writes a ledger
  // row with `outcome = 'unknown'`, so each attempt's possible charge is
  // counted and the org's total says "≥".
  //
  // `internal` rather than a code of its own: the closed set has no member for
  // "we do not know", and `internal` is the documented generic for exactly that
  // — the bound that fired is ours, not the provider's.
  if (isTimeoutError(cause)) return withRunFailure(new TransientError(TIMED_OUT), "internal");

  if (APICallError.isInstance(cause) && cause.isRetryable === true) {
    return withRunFailure(
      new TransientError(redactSecrets(cause.message), retryAfterSeconds(cause.responseHeaders)),
      "rate_limited",
    );
  }

  if (APICallError.isInstance(cause)) {
    return withRunFailure(
      new PermanentError(redactSecrets(cause.message), cause.statusCode),
      // No status at all still reads as `provider_refused` rather than
      // `internal`: the call failed at the provider boundary, and "check the key
      // and the model id" remains the useful thing to say about it.
      codeForStatus(cause.statusCode),
    );
  }

  // Not the provider's doing as far as anything here can tell — a `TypeError`
  // in our own code, a dropped socket, a thrown string. `internal` is the
  // honest answer, and the message goes to the log for whoever has to fix it.
  return withRunFailure(new PermanentError(redactSecrets(messageOf(cause))), "internal");
}

function codeForStatus(statusCode: number | undefined): RunFailure {
  if (statusCode === 401 || statusCode === 403) return "invalid_key";
  if (statusCode === 404) return "model_not_found";
  return "provider_refused";
}

/**
 * What a cancelled call is reported as, in the log. The user is shown the
 * `cancelled` code's own translated sentence instead.
 */
const CANCELLED = "the model call was cancelled before it finished";

/**
 * What a call that outlived its budget is reported as, in the log. The user is
 * shown the code's own translated sentence instead.
 */
const TIMED_OUT =
  "the model call ran out of time before the provider answered; whether it was billed is unknown";

/**
 * Take the secrets out of a provider's own sentence before it reaches a log.
 *
 * The prose is kept — it is what an operator needs — but a provider decides its
 * wording, and providers put credentials in it: OpenAI-style bodies quote the
 * submitted key back, and Google's errors quote the request URL, which carries
 * `?key=`. `secret`, when the caller has it in scope, removes that exact string;
 * the patterns are the defence for every case where it is not in scope (a key
 * belonging to another org, a token in a proxy's body, a key a model wrote into
 * its own output).
 *
 * The literal-string half is `redactToken`'s (`@pubrick/integrations`, for
 * Telegram's bot token) three lines exactly. The pattern half is not shareable
 * as written — a bot token rides in a URL PATH (`/bot<token>/`) and an AI key in
 * a query parameter or an `Authorization` header — so the two live apart until
 * one of them grows a second caller; neither may grow a copy of the other.
 */
export function redactSecrets(message: string, secret?: string): string {
  const withoutLiteral =
    secret !== undefined && secret.trim() !== "" ? message.split(secret).join("***") : message;

  return (
    withoutLiteral
      // `?key=…` / `&key=…` — Google puts the API key here, and its own error
      // bodies quote the request URL back at us.
      .replace(/([?&]key=)[^&\s"'`]+/gi, "$1***")
      // `Authorization: Bearer …` — OpenRouter and most OpenAI-compatible
      // providers.
      .replace(/(\bBearer\s+)[\w.\-~+/=]+/gi, "$1***")
      // The two key shapes our two supported providers actually issue, for the
      // case where the key is in the prose rather than in a URL or a header.
      .replace(/\bsk-[\w-]{8,}/gi, "sk-***")
      .replace(/\bAIza[\w-]{10,}/g, "AIza***")
  );
}

/**
 * Did this end because someone cancelled it?
 *
 * Keyed on `name`, never on the message: the message differs by construction
 * site — `AbortController#abort()` gives "This operation was aborted", while an
 * abort landing inside the SDK's own retry backoff gives
 * `DOMException("Delay was aborted", "AbortError")` — and a provider whose 500
 * body merely mentioned aborting would otherwise be reported as a cancellation
 * nobody asked for. `DOMException` is the usual carrier, but runtimes differ,
 * so anything named `AbortError` counts.
 *
 * Written here rather than imported: the SDK's own `isAbortError` lives in
 * `@ai-sdk/provider-utils`, which this package does not depend on, and it also
 * folds in `TimeoutError`, which is a different thing said in the same shape.
 */
function isAbortError(error: unknown): boolean {
  return nameOf(error) === "AbortError";
}

/**
 * Did this end because our own time budget ran out?
 *
 * `AbortSignal.timeout()` aborts with `DOMException("…due to timeout",
 * "TimeoutError")`, and `AbortSignal.any()` passes that reason through — which
 * is what lets the composite signal say WHICH of the two fired. The SDK's own
 * `isAbortError` folds the two together; here they are two different sentences
 * about two different things, so they are kept apart.
 */
function isTimeoutError(error: unknown): boolean {
  return nameOf(error) === "TimeoutError";
}

/** Keyed on `name`, never on the message — see `isAbortError`. */
function nameOf(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return undefined;
  return (error as { name?: unknown }).name;
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

  const rawMs = headers["retry-after-ms"]?.trim();
  if (rawMs !== undefined && rawMs !== "") {
    const ms = Number(rawMs);
    if (Number.isFinite(ms) && ms > 0) return Math.ceil(ms / 1000);
  }

  // An empty or whitespace-only header is not a hint. `Number("")` is 0, which
  // would otherwise be read as "retry immediately" and turn a rate limit into a
  // hot loop against the provider that just asked us to slow down.
  const raw = headers["retry-after"]?.trim();
  if (raw === undefined || raw === "") return undefined;

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
