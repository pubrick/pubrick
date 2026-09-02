import type { AbortCause } from "./classify.js";

/**
 * The two signals one model call listens to, composed into the one the SDK is
 * handed — plus the one fact composing them destroys: WHICH of them fired.
 *
 * `AbortSignal.any` passes the first source's abort reason through, and for a
 * moment that reason is the whole story: our budget aborts with
 * `DOMException(…, "TimeoutError")` and a caller's `abort()` with
 * `DOMException(…, "AbortError")`. The story does not survive the SDK. Measured
 * against ai@7.0.83: an abort that lands while `retryWithExponentialBackoff` is
 * sleeping is rejected by the SDK's own `delay()` with a reason it CONSTRUCTS —
 * `DOMException("Delay was aborted", "AbortError")` — so our two-minute budget
 * arrives at the classifier wearing a user's cancellation.
 *
 * That is the difference between a run that resumes and a run that is over, and
 * between two sentences the user reads, so it is recorded here, at the only
 * point where it still exists, rather than guessed downstream from a name.
 */
export type CallBudget = {
  /** What to hand the SDK: the caller's signal and our deadline, composed. */
  readonly signal: AbortSignal;
  /**
   * Which signal fired FIRST, or undefined while neither has.
   *
   * First, not "did ours fire": both can be aborted by the time an error is
   * caught — a caller pressing stop does not stop our timer — and the one that
   * ended the call is the one that ended it.
   */
  abortedBy: () => AbortCause | undefined;
  /**
   * Drop our listener from the CALLER's signal, which may outlive this call by
   * a whole worker process. Ours is `AbortSignal.timeout`'s own and goes with
   * it. Idempotent, so a `finally` can call it on every path.
   */
  release: () => void;
};

/**
 * Give one logical model call a deadline, without losing the caller's own
 * signal or the ability to say which of the two ended it.
 */
export function createCallBudget(timeoutMs: number, callerSignal?: AbortSignal): CallBudget {
  // The timer does not hold the event loop open, so a call that returns early
  // leaves nothing running behind it.
  const budget = AbortSignal.timeout(timeoutMs);

  // A signal that is ALREADY aborted never fires a listener, so the one case
  // events cannot report is read directly. It is also the common one: the
  // pre-dispatch check exists precisely for a caller that cancelled first.
  let firstToFire: AbortCause | undefined = callerSignal?.aborted === true ? "caller" : undefined;
  const onTimeout = () => {
    firstToFire ??= "timeout";
  };
  const onCaller = () => {
    firstToFire ??= "caller";
  };

  budget.addEventListener("abort", onTimeout, { once: true });
  callerSignal?.addEventListener("abort", onCaller, { once: true });

  return {
    signal: callerSignal === undefined ? budget : AbortSignal.any([callerSignal, budget]),
    abortedBy: () => firstToFire,
    release: () => callerSignal?.removeEventListener("abort", onCaller),
  };
}
