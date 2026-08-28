"use client";

import { useCallback, useEffect, useState } from "react";

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
  /** Re-runs the fetch immediately and, if the value is not terminal, resumes polling. */
  refresh: () => void;
};

/**
 * Polls `fetcher` until `isTerminal` says the value has stopped changing.
 *
 * The app's first polling of any kind, so the rules it has to keep are written
 * here rather than learned twice:
 *
 * - The timer is cleared on unmount **and** the moment a terminal value
 *   arrives. Only clearing on unmount leaves a finished run being re-read every
 *   two seconds for as long as its receipt is on screen.
 * - Nothing is written after unmount: a response that lands late is dropped, so
 *   a navigation mid-request cannot produce a React state update on a component
 *   that is gone.
 * - An error stops the polling instead of retrying forever. The two errors that
 *   actually happen here are permanent (the run row is gone; the session
 *   expired), and a poll that keeps firing to re-learn the same 404 is spend
 *   with no reader. `refresh()` is the way back.
 *
 * `fetcher` and `isTerminal` must be stable (module-level, or `useCallback`) —
 * they are effect dependencies, so that changing WHAT is polled (a different
 * run id) restarts the poll, exactly as the React dependency contract implies.
 * An inline arrow would restart the poll on every render, which is a request
 * loop; `useExhaustiveDependencies` flags the missing dependency if either is
 * left out.
 */
export function usePoll<T>(
  fetcher: () => Promise<T>,
  isTerminal: (value: T) => boolean,
  options: PollOptions = {},
): PollResult<T> {
  const { intervalMs = POLL_INTERVAL_MS, hiddenIntervalMs = POLL_HIDDEN_INTERVAL_MS } = options;
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  // Bumped by refresh(); the effect below keys off it, so a refresh tears the
  // old timer down and starts a clean cycle rather than racing a live one.
  const [attempt, setAttempt] = useState(0);

  const refresh = useCallback(() => setAttempt((n) => n + 1), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `attempt` is a restart key, not a value this effect reads. Bumping it is exactly how refresh() tears the old timer down and starts a clean cycle; taking the rule's fix would make refresh() a no-op in the one situation it exists for — after the poll has stopped.
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
        stopped = true;
        clear();
        return;
      }
      schedule();
    }

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
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [fetcher, isTerminal, intervalMs, hiddenIntervalMs, attempt]);

  return { data, error, refresh };
}
