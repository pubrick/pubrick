import { RUN_FAILURES } from "@pubrick/shared";
import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import {
  isTerminalRunStatus,
  RUN_BADGE_STATUS,
  RUN_STATUSES,
  type RunDetail,
  type RunStepKey,
  runFailureMessage,
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
    errorCode: null,
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
    const run = makeRun({ status: "failed", currentStep: "writer", errorCode: "provider_refused" });

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

  it("says a terminal run's un-reached steps did not run, rather than that they are waiting", () => {
    // "Waiting" is a promise that the step is still going to happen. On a run
    // that is over it is simply false — and it was what the receipt showed for
    // all five steps of a failed run.
    const failed = makeRun({
      status: "failed",
      currentStep: "writer",
      steps: { researcher: { status: "succeeded" } },
      errorCode: "provider_refused",
    });

    expect(stateOf(failed, "researcher")).toBe("done");
    expect(stateOf(failed, "writer")).toBe("failed");
    expect(stateOf(failed, "editor")).toBe("skipped");
    expect(stateOf(failed, "factcheck")).toBe("skipped");
    expect(stateOf(failed, "adapter")).toBe("skipped");

    const cancelled = makeRun({
      status: "cancelled",
      currentStep: "writer",
      steps: { researcher: { status: "succeeded" } },
    });

    expect(stateOf(cancelled, "researcher")).toBe("done");
    // Nothing is running and nothing will: the job was cancelled standing here.
    expect(stateOf(cancelled, "writer")).toBe("skipped");
  });

  it("keeps 'waiting' for a run that has not finished", () => {
    const queued = makeRun({ status: "queued" });
    expect(runStepStates(queued).every((s) => s.state === "pending")).toBe(true);

    const running = makeRun({ status: "running", currentStep: "researcher" });
    expect(stateOf(running, "factcheck")).toBe("pending");
  });
});

/**
 * The screens print THIS, and never `run.errorCode` itself.
 *
 * The column behind it used to hold the provider's own error sentence, which is
 * where a submitted API key gets quoted back and which only ever exists in
 * English. Rows written then are still in the database, so "anything I do not
 * recognise" has to mean "say the generic thing", not "print it".
 */
describe("runFailureMessage", () => {
  const t = (key: string) => `translated:${key}`;

  it("translates every code the API can send", () => {
    for (const code of RUN_FAILURES) {
      expect(runFailureMessage(t, code)).toBe(`translated:failure.${code}`);
      // ...and the key it asks for exists in the reference locale, so the
      // screen shows a sentence rather than a dotted path.
      expect(en.Runs.failure).toHaveProperty(code);
    }
  });

  it("says nothing at all for a run that has not failed", () => {
    expect(runFailureMessage(t, null)).toBeNull();
    expect(runFailureMessage(t, "")).toBeNull();
  });

  it("never prints a value it does not recognise", () => {
    // A row from before the codes existed. Printing it would put the provider's
    // own sentence — the one that can carry a key — on the screen, which is the
    // whole defect.
    expect(runFailureMessage(t, "Incorrect API key provided: sk-live-51ABCdef")).toBe(
      "translated:genericError",
    );
    // ...and a code from a newer API than this build knows.
    expect(runFailureMessage(t, "some_future_code")).toBe("translated:genericError");
  });
});
