import { describe, expect, it } from "vitest";
import {
  briefRunInputSchema,
  DISMISSABLE_RUN_STATUSES,
  isLiveRunStatus,
  LIVE_RUN_STATUSES,
  RUN_STATUSES,
  runStepCheckpointSchema,
  runStepsSchema,
} from "./runs.js";

/**
 * The set six call sites used to spell out for themselves — the brand delete's
 * job cancellation, the cancel guard, the queue strip's `open` filter, the
 * concurrency cap's count, the worker's fence claim and the dead-letter
 * consumer's write. Each of those reads the list rather than its own literal
 * now, so this is the one place a member can be added or dropped, and these are
 * the assertions that notice.
 */
describe("which runs the queue still owns", () => {
  it("is exactly the two statuses with a generate job behind them", () => {
    expect([...LIVE_RUN_STATUSES]).toEqual(["queued", "running"]);
  });

  it("answers for every status the enum has, and only those", () => {
    expect(RUN_STATUSES.filter(isLiveRunStatus)).toEqual(["queued", "running"]);
  });

  /**
   * The one a settled run must not be caught by: `succeeded`, `failed` and
   * `cancelled` are what the api's cancel and dismiss refusals are keyed on
   * (`Record<SettledRunStatus, …>`), and what the web treats as "stop polling".
   */
  it("leaves every settled status out, so nothing re-claims a finished run", () => {
    expect(RUN_STATUSES.filter((status) => !isLiveRunStatus(status))).toEqual([
      "succeeded",
      "failed",
      "cancelled",
    ]);
  });
});

/**
 * The runtime half of the compile-time assertion in `runs.ts`: every status is
 * classified exactly once, so a new one cannot fall through the queue strip's
 * `open` filter — which is `live OR (dismissable AND undismissed)` — and become
 * a run nobody can see.
 */
describe("the queue strip's classification of a run", () => {
  it("carries a settled run until a human dismisses it, unless it left a draft", () => {
    expect([...DISMISSABLE_RUN_STATUSES]).toEqual(["failed", "cancelled"]);
  });

  it("classifies every status exactly once", () => {
    const offStrip = RUN_STATUSES.filter(
      (status) =>
        !isLiveRunStatus(status) &&
        !(DISMISSABLE_RUN_STATUSES as readonly string[]).includes(status),
    );
    expect(offStrip).toEqual(["succeeded"]);
    const live = LIVE_RUN_STATUSES as readonly string[];
    expect(DISMISSABLE_RUN_STATUSES.filter((status) => live.includes(status))).toEqual([]);
  });
});

/**
 * `pipeline_runs.input`, which had three descriptions of it — a drizzle
 * `$type<>()`, a copy in the web, and this parse — and only the parse could
 * notice a change.
 */
describe("what a run was asked to produce", () => {
  const valid = {
    kind: "brief",
    text: "Announce the autumn menu",
    channelIds: ["11111111-1111-4111-8111-111111111111"],
  };

  it("accepts the shape the api writes", () => {
    expect(briefRunInputSchema.parse(valid)).toEqual(valid);
  });

  it("refuses a run with no channels, which would produce an item nothing ships", () => {
    expect(briefRunInputSchema.safeParse({ ...valid, channelIds: [] }).success).toBe(false);
  });

  it("refuses a kind this build cannot execute rather than crashing inside a step", () => {
    expect(briefRunInputSchema.safeParse({ ...valid, kind: "topic" }).success).toBe(false);
  });
});

/**
 * `pipeline_runs.steps`. The `failed` arm is the point: no writer produces one
 * today and the run receipt renders it, so it is the column's shape rather than
 * the current worker's that this schema states.
 */
describe("a step checkpoint", () => {
  it("admits the failed arm the worker does not write and the receipt renders", () => {
    expect(runStepCheckpointSchema.parse({ status: "failed" })).toEqual({ status: "failed" });
  });

  it("keeps the halves the worker fills optional, since a reader may find them missing", () => {
    expect(runStepCheckpointSchema.parse({ status: "succeeded" })).toEqual({
      status: "succeeded",
    });
  });

  it("refuses a status that is neither", () => {
    expect(runStepCheckpointSchema.safeParse({ status: "running" }).success).toBe(false);
  });

  it("is keyed per step, so a fan-out's channels each get their own entry", () => {
    const steps = {
      writer: { status: "succeeded", output: { body: "x" }, finishedAt: "2026-09-04T00:00:00Z" },
      "adapter:11111111-1111-4111-8111-111111111111": { status: "succeeded" },
    };
    expect(runStepsSchema.parse(steps)).toEqual(steps);
  });
});
