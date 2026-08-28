import { describe, expect, it } from "vitest";
import {
  isTerminalRunStatus,
  RUN_BADGE_STATUS,
  RUN_STATUSES,
  type RunDetail,
  type RunStepKey,
  runStepStates,
} from "./runs";

const CH_A = "channel-a";
const CH_B = "channel-b";

function makeRun(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    id: "run-1",
    brandId: "brand-1",
    input: { kind: "brief", text: "Brief", channelIds: [CH_A] },
    status: "queued",
    currentStep: null,
    contentItemId: null,
    error: null,
    dismissedAt: null,
    steps: {},
    createdAt: "2026-08-28T10:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
    ...overrides,
  };
}

const stateOf = (run: RunDetail, key: RunStepKey) =>
  runStepStates(run).find((step) => step.key === key)?.state;

describe("RUN_BADGE_STATUS", () => {
  it("maps every run status to one of the five status colors", () => {
    for (const status of RUN_STATUSES) {
      expect(RUN_BADGE_STATUS[status]).toBeDefined();
    }
    // The mapping the spec fixes: in-flight is blue, success is green,
    // cancelled is the grey of something that never happened.
    expect(RUN_BADGE_STATUS.queued).toBe("scheduled");
    expect(RUN_BADGE_STATUS.running).toBe("scheduled");
    expect(RUN_BADGE_STATUS.succeeded).toBe("published");
    expect(RUN_BADGE_STATUS.failed).toBe("failed");
    expect(RUN_BADGE_STATUS.cancelled).toBe("draft");
  });
});

describe("isTerminalRunStatus", () => {
  it("is true exactly for the statuses nothing moves out of on its own", () => {
    expect(isTerminalRunStatus("queued")).toBe(false);
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("succeeded")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
  });
});

describe("runStepStates", () => {
  it("shows five steps, all waiting, for a run that has not started", () => {
    const states = runStepStates(makeRun());
    expect(states.map((s) => s.key)).toEqual([
      "researcher",
      "writer",
      "editor",
      "factcheck",
      "adapter",
    ]);
    expect(states.every((s) => s.state === "pending")).toBe(true);
  });

  it("marks checkpointed steps done and the current one active", () => {
    const run = makeRun({
      status: "running",
      currentStep: "editor",
      steps: { researcher: { status: "succeeded" }, writer: { status: "succeeded" } },
    });

    expect(stateOf(run, "researcher")).toBe("done");
    expect(stateOf(run, "writer")).toBe("done");
    expect(stateOf(run, "editor")).toBe("active");
    expect(stateOf(run, "factcheck")).toBe("pending");
  });

  it("marks the step a failed run died on as failed, even with no checkpoint for it", () => {
    // A failing step writes no checkpoint — the error lands on the run — so
    // reading only the checkpoint map would show the step that broke as
    // "waiting" forever.
    const run = makeRun({ status: "failed", currentStep: "writer", error: "provider refused" });

    expect(stateOf(run, "writer")).toBe("failed");
  });

  it("counts the adapter fan-out as one row over all channels", () => {
    const run = makeRun({
      status: "running",
      currentStep: `adapter:${CH_B}`,
      input: { kind: "brief", text: "Brief", channelIds: [CH_A, CH_B] },
      steps: { [`adapter:${CH_A}`]: { status: "succeeded" } },
    });

    const adapter = runStepStates(run).find((s) => s.key === "adapter");
    expect(adapter).toMatchObject({ state: "active", done: 1, total: 2 });
  });

  it("reads the adapter as done only once every channel has its checkpoint", () => {
    const run = makeRun({
      status: "succeeded",
      currentStep: null,
      input: { kind: "brief", text: "Brief", channelIds: [CH_A, CH_B] },
      steps: {
        [`adapter:${CH_A}`]: { status: "succeeded" },
        [`adapter:${CH_B}`]: { status: "succeeded" },
      },
    });

    expect(stateOf(run, "adapter")).toBe("done");
  });

  it("leaves a cancelled run's unreached steps waiting, never in progress", () => {
    const run = makeRun({
      status: "cancelled",
      currentStep: "writer",
      steps: { researcher: { status: "succeeded" } },
    });

    expect(stateOf(run, "researcher")).toBe("done");
    // Nothing is running: the job was cancelled while standing here.
    expect(stateOf(run, "writer")).toBe("pending");
  });
});
