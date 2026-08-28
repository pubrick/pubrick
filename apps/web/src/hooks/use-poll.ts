"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api";

/** How often a live run is re-read while the tab is in front. */
export const POLL_INTERVAL_MS = 2000;
/**
 * ...and while it is not. A hidden tab has no reader, so the only thing a
 * 2-second poll buys there is requests and, on a metered API, money. It is a
 * back-off rather than a stop so that a tab left open for an hour still shows
 * a finished run when its owner comes back, without a reload.
 */
export const POLL_HIDDEN_INTERVAL_MS = 30_000;

export type PollOptions = { intervalMs?: number; hiddenIntervalMs?: number };

export type PollResult<T> = {
  data: T | null;
  error: unknown;
  /**
   * Fetches once, right now, and resumes polling if the value is not terminal.
   *
   * Awaitable on purpose: a mutation handler that wants the list it just
   * changed to be re-read has to be able to sequence the re-read after its own
   * write, and to know when the rendered result is current.
   */
  refresh: () => Promise<void>;
  /**
   * Applies a change the caller already knows to be true to the rendered value,
   * without waiting for a round trip.
   *
   * This is not a cache the client maintains — the next poll overwrites it, and
   * the server stays the authority on what the value is. It exists so that a
   * mutation's visible result does not depend on a re-read landing: a dismissed
   * run leaving the strip is something the caller knows the moment its write
   * succeeded, and making the user's own action wait on a request that might
   * fail is how a screen ends up frozen rather than merely stale.
   */
  mutate: (update: (previous: T | null) => T | null) => void;
};

const NOOP = async () => {};

/**
 * A definite answer about this request that will not change by asking again:
 * the row is gone (404), the caller may not see it (403), the session expired
 * (401). Everything else — a 5xx, a dropped connection, `ApiError(0)` — is a
 * blip, and stopping on it would end progress updates for a run that is still
 * going.
 */
function isPermanent(err: unknown): boolean {
  return err instanceof ApiError && err.status >= 400 && err.status < 500;
}

/**
 * Polls `fetcher` until `isTerminal` says the value has stopped changing.
 *
 * The app's only polling, so the rules it has to keep are written here rather
 * than learned twice:
 *
 * - The timer is cleared on unmount **and** the moment a terminal value
 *   arrives. Only clearing on unmount leaves a finished run being re-read every
 *   two seconds for as long as its receipt is on screen.
 * - A response that lands after unmount is dropped. Under React 19 the state
 *   write itself would be a silent no-op, so this is NOT the crash guard the
 *   comment here used to claim: no test can distinguish keeping it from
 *   dropping it. What it actually does is stop a torn-down instance from
 *   scheduling the next tick, and keep one rule ("a stopped instance writes
 *   nothing") instead of two.
 * - A transient failure does NOT stop the poll; a 4xx does. See `isPermanent`.
 *
 * `refresh()` calls THIS instance's fetch directly rather than restarting the
 * effect through a state key. The indirect version shipped first and was wrong
 * in a way worth recording: a restart marks the previous effect instance
 * stopped, and a stopped instance drops the response it already has in flight —
 * so a refresh whose effect was re-run again before its own response landed
 * silently discarded that response, leaving the list rendering data older than
 * the mutation the user had just made. Polling directly has no instance to lose
 * the race against, and it makes the refresh awaitable, which is what lets a
 * caller sequence it after its own write.
 *
 * `fetcher` and `isTerminal` must be stable (module-level, or `useCallback`) —
 * they are effect dependencies, so changing WHAT is polled (a different run id)
 * restarts the poll. An inline arrow would restart it on every render, which is
 * a request loop; `useExhaustiveDependencies` flags either one if it is left
 * out.
 */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  isTerminal: (value: T) => boolean,
  options: PollOptions = {},
): PollResult<T> {
  const { intervalMs = POLL_INTERVAL_MS, hiddenIntervalMs = POLL_HIDDEN_INTERVAL_MS } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);

  // Points at the live effect instance's fetch, and at a no-op once that
  // instance is torn down — so a refresh() racing an unmount cannot resurrect
  // a dead poll or write state after the component is gone.
  const pollNowRef = useRef<() => Promise<void>>(NOOP);
  const refresh = useCallback(() => pollNowRef.current(), []);
  const mutate = useCallback((update: (previous: T | null) => T | null) => setData(update), []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function clear() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    }

    function schedule() {
      clear();
      if (stopped) return;
      timer = setTimeout(poll, document.hidden ? hiddenIntervalMs : intervalMs);
    }

    async function poll() {
      try {
        const value = await fetcher();
        if (stopped) return;
        setData(value);
        setError(null);
        if (isTerminal(value)) {
          stopped = true;
          clear();
          return;
        }
      } catch (err) {
        if (stopped) return;
        setError(err);
        if (isPermanent(err)) {
          stopped = true;
          clear();
          return;
        }
      }
      schedule();
    }

    const pollNow = async () => {
      // A refresh resumes a poll that had stopped — on a terminal value, or on
      // a 4xx. If the value is still terminal, the fetch below stops it again.
      stopped = false;
      clear();
      await poll();
    };
    pollNowRef.current = pollNow;

    // Re-price the delay that is already ticking, in both directions: hiding a
    // tab whose next poll is 2s away should back that poll off, and showing it
    // again should not make the reader wait out the 30s that was scheduled
    // while nobody was looking. A poll in flight (no pending timer) needs
    // nothing — it schedules the next one itself, at whatever the delay is by
    // then.
    function onVisibilityChange() {
      if (stopped || timer === undefined) return;
      schedule();
    }

    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      stopped = true;
      clear();
      if (pollNowRef.current === pollNow) pollNowRef.current = NOOP;
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [fetcher, isTerminal, intervalMs, hiddenIntervalMs]);

  return { data, error, refresh, mutate };
}
