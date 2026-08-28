import type { StatusBadgeStatus } from "@/components/ui/status-badge";

/**
 * A generation run's lifecycle, as the API reports it.
 *
 * A local copy of `@pubrick/db`'s `RUN_STATUSES`, exactly as this app already
 * keeps its own `ContentStatus`/`AdaptationStatus`: the web package has no
 * database dependency and must not grow one for a string union. The maps below
 * are keyed by it, so a status added upstream and mirrored here without a
 * decision is a compile error rather than a blank badge.
 */
export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/**
 * The five status colors (constitution) mapped from every run status that
 * exists. `queued` and `running` share `scheduled`'s blue — their own
 * translated labels are unaffected, only the color — `succeeded` reads as
 * `published` green, and a `cancelled` run is the grey of something that never
 * happened rather than the red of something that broke.
 *
 * Total by construction: a sixth run status cannot be rendered until someone
 * decides which of the five colors it wears.
 */
export const RUN_BADGE_STATUS: Record<RunStatus, StatusBadgeStatus> = {
  queued: "scheduled",
  running: "scheduled",
  succeeded: "published",
  failed: "failed",
  cancelled: "draft",
};

/** Statuses from which nothing further happens on its own — where polling stops. */
const TERMINAL_RUN_STATUSES = [
  "succeeded",
  "failed",
  "cancelled",
] as const satisfies readonly RunStatus[];

export function isTerminalRunStatus(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

/**
 * The same five colors for the per-step checklist. A step is not a content
 * status, but it has the same four things to say — finished, in flight, broken,
 * not started yet — and inventing a sixth palette for them is precisely what
 * the constitution forbids.
 */
export const RUN_STEP_BADGE_STATUS: Record<RunStepState, StatusBadgeStatus> = {
  done: "published",
  active: "scheduled",
  failed: "failed",
  pending: "draft",
  skipped: "draft",
};

/**
 * How often the queue re-reads `?state=open`.
 *
 * Slower than a run receipt's own poll: this is a LIST, and unlike a single
 * run it never reaches a state where it can stop (see `runStepStates`' caller
 * on the queue screen) — so the cadence is what an always-on request costs
 * every user with the main screen open, rather than what a person watching one
 * run wants to see.
 */
export const OPEN_RUNS_POLL_INTERVAL_MS = 5000;

/** What a run was asked to produce. `kind` is discriminated upstream for later increments. */
export type RunInput = { kind: "brief"; text: string; channelIds: string[] };

/** `GET /api/runs` — the strip's shape. No `steps`: see `RunDetail`. */
export type Run = {
  id: string;
  brandId: string;
  input: RunInput;
  status: RunStatus;
  currentStep: string | null;
  contentItemId: string | null;
  error: string | null;
  dismissedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/** One finished step, as checkpointed by the worker. */
export type RunStepCheckpoint = { status: "succeeded" | "failed" };

/** `GET /api/runs/:id` — the receipt's shape, which adds the checkpoint map. */
export type RunDetail = Run & { steps: Record<string, RunStepCheckpoint> };

/**
 * The five roles, in the order the worker runs them. `adapter` is one row for
 * the whole fan-out even though its checkpoints are keyed `adapter:<channelId>`
 * — the human is watching one pipeline, not N of them, and the per-channel
 * progress rides along as a count.
 */
export const RUN_STEP_KEYS = ["researcher", "writer", "editor", "factcheck", "adapter"] as const;
export type RunStepKey = (typeof RUN_STEP_KEYS)[number];

/**
 * `pending` and `skipped` look alike and are not: "waiting" is a promise that
 * the step is still going to run, and on a run that is over that is a lie.
 * A failed or cancelled run's un-reached steps read "not run" instead.
 */
export type RunStepState = "done" | "active" | "failed" | "pending" | "skipped";

export type RunStepProgress = {
  key: RunStepKey;
  state: RunStepState;
  /** Only meaningful for `adapter`: channels adapted so far, out of how many. */
  done: number;
  total: number;
};

const ADAPTER_PREFIX = "adapter:";

/**
 * The live checklist, derived from the run row alone.
 *
 * Nothing here is stored: a step is done when its checkpoint says so, failed
 * when its checkpoint says so OR when the run failed while standing on it (a
 * failing step writes no checkpoint — the error lands on the run), active only
 * while the run is actually running, and pending otherwise. A cancelled run's
 * unreached steps therefore read "pending" rather than pretending to still be
 * in progress.
 */
export function runStepStates(run: RunDetail): RunStepProgress[] {
  const channelIds = run.input?.channelIds ?? [];

  return RUN_STEP_KEYS.map((key) => {
    if (key === "adapter") {
      const checkpoints = channelIds.map((channelId) => run.steps[`${ADAPTER_PREFIX}${channelId}`]);
      const done = checkpoints.filter((c) => c?.status === "succeeded").length;
      const total = channelIds.length;
      const isCurrent = run.currentStep?.startsWith(ADAPTER_PREFIX) ?? false;
      const state =
        total > 0 && done === total
          ? "done"
          : stepState(
              run,
              checkpoints.find((c) => c?.status === "failed"),
              isCurrent,
            );
      return { key, state, done, total };
    }

    const checkpoint = run.steps[key];
    const isCurrent = run.currentStep === key;
    return { key, state: stepState(run, checkpoint, isCurrent), done: 0, total: 0 };
  });
}

function stepState(
  run: RunDetail,
  checkpoint: RunStepCheckpoint | undefined,
  isCurrent: boolean,
): RunStepState {
  if (checkpoint?.status === "succeeded") return "done";
  if (checkpoint?.status === "failed") return "failed";
  if (isCurrent && run.status === "failed") return "failed";
  if (isCurrent && run.status === "running") return "active";
  // Nothing more will happen to this run, so a step with no checkpoint never
  // ran and never will — it is not waiting for anything.
  return isTerminalRunStatus(run.status) ? "skipped" : "pending";
}
