import {
  isLiveRunStatus,
  isRunFailure,
  type RunDetailDto,
  type RunDto,
  type RunFailure,
  type RunStatus,
  type RunStepCheckpoint,
} from "@pubrick/shared";
import type { StatusBadgeStatus } from "@/components/ui/status-badge";

/**
 * A generation run's lifecycle, as the API reports it.
 *
 * Re-exported from `@pubrick/shared`, which is where the list is declared. It
 * used to be a hand-written COPY of `@pubrick/db`'s, justified by this app
 * having no database dependency — true, and not a reason to write the list
 * twice, since every screen here already imports the package that now holds it.
 * Nothing compared the two, so a status added upstream reached this app as a
 * `RUN_BADGE_STATUS` lookup returning `undefined` and a badge rendered with
 * `undefined` classes.
 */
export { RUN_STATUSES, type RunStatus } from "@pubrick/shared";

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

/**
 * Statuses from which nothing further happens on its own — where polling stops.
 *
 * THE COMPLEMENT OF `LIVE_RUN_STATUSES`, computed, not listed. It was listed —
 * `["succeeded", "failed", "cancelled"]` — and that made it the one spelling of
 * this partition that would answer a NEW status differently from the six that
 * spell out the live half: a status in neither list is not live (so nothing
 * will move it) and not terminal (so this screen polls it for ever, and its
 * un-reached steps say "waiting" about a run that is over). "The queue is not
 * going to touch this again" and "stop asking" are one fact, so they get one
 * definition and the negation says which side this app is asking from.
 */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return !isLiveRunStatus(status);
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

/** What a run was asked to produce — the column's own schema, inferred. */
export type { RunInput } from "@pubrick/shared";

/**
 * `GET /api/runs` — the strip's shape. No `steps`: see `RunDetail`.
 *
 * THE WIRE SCHEMA'S OWN TYPE, not a hand-written twin of it. This app used to
 * declare the response shape itself, and the api's allowlist declared it
 * again, with nothing comparing the two — which is how a column the worker
 * had started counting (`unrecordedCalls`) could be selected by neither, typed
 * by neither, and rendered nowhere for a day with every suite green.
 * `runDtoSchema` is what the api's e2e parses a real response with, and what
 * this app's receipt tests build their fixtures through, so the api, the wire
 * and this screen now describe one body.
 *
 * `errorCode` is `string | null` there rather than `RunFailure | null`, and on
 * purpose: rows written before the codes existed still hold prose, and
 * `runFailureMessage` below is the thing that decides what a reader sees.
 * `unrecordedCalls` is `number | null`, and NULL is not zero — see the schema.
 */
export type Run = RunDto;

/**
 * One finished step, as checkpointed by the worker — the column's own schema.
 *
 * This app used to declare a THIRD shape for it, narrower than the column's by
 * two fields; the worker declares a narrower one still, for what it writes.
 * `output` is the step's own model output, `unknown` because it is jsonb inside
 * jsonb and its shape is whatever the worker build that wrote it produced. The
 * readers below narrow it; nothing else in this app may touch it raw.
 */
export type { RunStepCheckpoint, RunSteps } from "@pubrick/shared";

/** `GET /api/runs/:id` — the receipt's shape, which adds the checkpoint map. */
export type RunDetail = RunDetailDto;

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

/**
 * A message key for every failure the API can report — the same total `Record`
 * the settings screen keeps for `AI_TEST_FAILURES`, and for the same reason: a
 * code added upstream without a sentence here is a COMPILE error, not a key
 * path rendered at a user in four languages.
 */
const RUN_FAILURE_KEYS: Record<RunFailure, string> = {
  cancelled: "failure.cancelled",
  every_channel_deleted: "failure.every_channel_deleted",
  internal: "failure.internal",
  invalid_key: "failure.invalid_key",
  model_not_found: "failure.model_not_found",
  no_api_key: "failure.no_api_key",
  no_structured_output: "failure.no_structured_output",
  provider_refused: "failure.provider_refused",
  rate_limited: "failure.rate_limited",
  retries_exhausted: "failure.retries_exhausted",
  timed_out: "failure.timed_out",
  too_long_for_channel: "failure.too_long_for_channel",
  unreadable_key: "failure.unreadable_key",
};

/**
 * The sentence for a run's failure, in the reader's language.
 *
 * Anything that is not one of the codes falls back to the generic sentence
 * rather than being printed. Two things arrive that way and neither may be
 * shown: a run row written before this column held codes, whose value is the
 * PROVIDER's own English — the sentence that can quote an API key — and a code
 * from a newer API than this build knows.
 */
export function runFailureMessage(
  t: (key: string) => string,
  errorCode: string | null,
): string | null {
  if (errorCode === null || errorCode === "") return null;
  return isRunFailure(errorCode) ? t(RUN_FAILURE_KEYS[errorCode]) : t("genericError");
}

/**
 * One claim the fact-checking step listed, in the shape it stores.
 *
 * `needsCheck` is the model's judgement that a reader could reasonably ask
 * whether the claim is true — NOT a verdict about the claim, and not the
 * result of a check. Nothing was checked: this step has no sources (see
 * `@pubrick/ai`'s FACTCHECK, and `CLAIMS_TO_VERIFY_LABEL`, which is what the
 * heading over this list says).
 */
export type RunClaim = { text: string; needsCheck: boolean };

/**
 * A step's stored output, but only from a checkpoint that SUCCEEDED.
 *
 * A `failed` checkpoint is written by a step that broke, and whatever sits in
 * its `output` is not a result. Returning it would put half a list under a
 * heading promising a whole one.
 */
function succeededOutput(run: RunDetail, key: RunStepKey): unknown {
  const checkpoint = run.steps?.[key];
  return checkpoint?.status === "succeeded" ? checkpoint.output : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The claims a run listed, for the reader who has to verify them.
 *
 * THREE answers, and the screen says a different sentence for each — collapsing
 * any two of them is how this receipt starts lying:
 * - an array — these are the claims (possibly a long list);
 * - `[]` — the step ran and listed nothing, which is a real outcome: a post can
 *   make no factual claim at all, and the step is instructed to return an empty
 *   list rather than invent one to fill the slot;
 * - `null` — there is nothing to say. No checkpoint (the run never got there,
 *   or is still on its way), a failed one, or stored output this build cannot
 *   read. A jsonb column written by an older worker is a real possibility here,
 *   and rendering junk at a user is worse than rendering nothing.
 *
 * The whole array is refused when any element is unreadable, rather than the
 * bad elements being dropped: a partial list under "claims to verify" is the
 * one failure mode that would send someone to publish having checked
 * everything they were shown.
 */
export function runClaims(run: RunDetail): RunClaim[] | null {
  const output = succeededOutput(run, "factcheck");
  if (!isRecord(output) || !Array.isArray(output.claims)) return null;
  const claims: RunClaim[] = [];
  for (const claim of output.claims) {
    if (!isRecord(claim)) return null;
    const { text, needsCheck } = claim;
    if (typeof text !== "string" || text === "" || typeof needsCheck !== "boolean") return null;
    claims.push({ text, needsCheck });
  }
  return claims;
}

/**
 * What the editor changed, in its own words — the same three answers as
 * `runClaims`, for the same reasons. `[]` means it changed nothing, which the
 * step is told to report honestly rather than inventing an edit to satisfy the
 * shape.
 *
 * The checkpoint also holds the edited BODY, and that is deliberately left
 * behind: the draft belongs on the item screen, where it can be edited, and a
 * receipt that reprinted it would put a second, frozen copy of the post on a
 * screen whose job is to say what happened to it.
 */
export function runEditorChanges(run: RunDetail): string[] | null {
  const output = succeededOutput(run, "editor");
  if (!isRecord(output) || !Array.isArray(output.changes)) return null;
  const changes: string[] = [];
  for (const change of output.changes) {
    if (typeof change !== "string" || change === "") return null;
    changes.push(change);
  }
  return changes;
}
