import { RUN_FAILURES } from "@pubrick/shared";
import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import pt from "../../messages/pt.json";
import ru from "../../messages/ru.json";
import {
  isTerminalRunStatus,
  RUN_BADGE_STATUS,
  RUN_STATUSES,
  type RunDetail,
  type RunStepKey,
  runClaims,
  runEditorChanges,
  runFailureMessage,
  runStepStates,
  sourceHost,
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
    unrecordedCalls: 0,
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

/**
 * The output the org paid for, on its way to a reader.
 *
 * Both readers take it from a SUCCEEDED checkpoint and from nowhere else, and
 * both distinguish three answers, because the screen has three sentences to
 * say: a list (here is what was produced), an empty list (it ran and produced
 * nothing), and `null` (nothing readable — do not claim either of the above).
 * Collapsing the last two is how "the step found nothing to flag" gets printed
 * over a step that never ran.
 */
describe("runClaims", () => {
  const claims = [
    { text: "Revenue tripled in Q2.", needsCheck: true },
    { text: "Water is wet.", needsCheck: false },
  ];

  it("reads the claims out of a succeeded factcheck checkpoint", () => {
    const run = makeRun({ steps: { factcheck: { status: "succeeded", output: { claims } } } });
    expect(runClaims(run)).toEqual(claims);
  });

  it("says [] — ran, listed nothing — for an empty list, and null for no checkpoint", () => {
    const ran = makeRun({ steps: { factcheck: { status: "succeeded", output: { claims: [] } } } });
    expect(runClaims(ran)).toEqual([]);
    // A run that never reached the step. Not the same answer, on purpose.
    expect(runClaims(makeRun())).toBeNull();
  });

  it("ignores a failed checkpoint: a step that broke produced no list", () => {
    const run = makeRun({ steps: { factcheck: { status: "failed", output: { claims } } } });
    expect(runClaims(run)).toBeNull();
  });

  it("refuses output it cannot read rather than rendering junk at a user", () => {
    // `steps` is a jsonb column written by whatever worker build was deployed
    // at the time. Everything here is a shape the API can really hand over.
    const shapes: unknown[] = [
      undefined,
      null,
      "claims",
      { claims: "one, two" },
      { claims: [{ text: "", needsCheck: true }] },
      { claims: [{ text: "No flag field" }] },
      { claims: [{ text: 42, needsCheck: true }] },
    ];
    for (const output of shapes) {
      expect(
        runClaims(makeRun({ steps: { factcheck: { status: "succeeded", output } } })),
      ).toBeNull();
    }
  });

  it("drops nothing it CAN read: a long list survives whole and in order", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      text: `Claim ${i}`,
      needsCheck: i % 2 === 0,
    }));
    const run = makeRun({
      steps: { factcheck: { status: "succeeded", output: { claims: many } } },
    });
    expect(runClaims(run)).toEqual(many);
  });
});

describe("runEditorChanges", () => {
  it("reads the change lines out of a succeeded editor checkpoint", () => {
    const changes = ["Cut the second paragraph.", "Tightened the opening line."];
    const run = makeRun({
      steps: { editor: { status: "succeeded", output: { body: "Edited body", changes } } },
    });
    expect(runEditorChanges(run)).toEqual(changes);
  });

  it("says [] — the editor changed nothing — apart from null for no checkpoint", () => {
    const ran = makeRun({
      steps: { editor: { status: "succeeded", output: { body: "Body", changes: [] } } },
    });
    expect(runEditorChanges(ran)).toEqual([]);
    expect(runEditorChanges(makeRun())).toBeNull();
  });

  it("refuses output it cannot read", () => {
    const shapes: unknown[] = [
      undefined,
      { changes: "one" },
      { body: "b", changes: [""] },
      { body: "b", changes: [7] },
    ];
    for (const output of shapes) {
      expect(
        runEditorChanges(makeRun({ steps: { editor: { status: "succeeded", output } } })),
      ).toBeNull();
    }
  });

  /**
   * The editor's checkpoint also holds the edited BODY, which is the draft
   * itself. This reader hands back the change notes and nothing else: the body
   * belongs on the item screen, where it can be edited, and a receipt that
   * reprinted it would put a second, frozen copy of the post on a screen whose
   * job is to say what happened to it.
   */
  it("returns only the notes, never the body it sits beside", () => {
    const run = makeRun({
      steps: {
        editor: { status: "succeeded", output: { body: "The whole post", changes: ["x"] } },
      },
    });
    expect(runEditorChanges(run)).toEqual(["x"]);
  });
});

/**
 * The sentences that sit UNDER the fact-check heading are held to the same
 * promise the heading is.
 *
 * `src/test/factcheck-label.test.ts` guards `Runs.step.factcheck` itself: the
 * step verifies nothing, and no string may say otherwise. These three are new
 * text in the same place, saying it in four languages, and the tempting
 * one-word "improvement" — "worth checking" to "checked", "listed" to
 * "verified" — is exactly as invisible here as it was there, in a language
 * nobody on the review reads.
 *
 * Same forbidden past participles as that test, for the same reason: an
 * infinitive or a gerund is an instruction to the reader, a past participle is
 * a claim about what already happened.
 */
describe("the claims list never says anything was checked", () => {
  /** Exactly the strings this receipt prints about the claims, in one locale. */
  type ClaimStrings = {
    claimsEmpty: string;
    claimNeedsCheck: string;
    step: { factcheck: string };
  };

  const cases: Array<[locale: string, runs: ClaimStrings, forbidden: RegExp[]]> = [
    ["en", en.Runs, [/\bverified\b/i, /\bchecked\b/i, /\bconfirmed\b/i]],
    ["es", es.Runs, [/verificad[oa]s?\b/i, /comprobad[oa]s?\b/i]],
    ["pt", pt.Runs, [/verificad[oa]s?\b/i, /checad[oa]s?\b/i]],
    ["ru", ru.Runs, [/проверен/i, /подтвержд/i]],
  ];

  it.each(cases)("holds every %s string under the heading to it", (_locale, runs, forbidden) => {
    const under = [runs.claimsEmpty, runs.claimNeedsCheck, runs.step.factcheck];
    for (const text of under) {
      for (const pattern of forbidden) expect(text).not.toMatch(pattern);
    }
  });
});

describe("sourceHost", () => {
  it("names the host a person would read out, without the scheme or the path", () => {
    expect(sourceHost("https://example.com/2026/09/the-story?utm=x")).toBe("example.com");
  });

  it("agrees with the gate's SQL: lowercased, THEN stripped of www.", () => {
    // `regexp_replace(lower(input->>'sourceUrl' …), '^www\\.', '')`. A host
    // derived the other way round keeps `WWW.` and counts as its own source,
    // which is the under-count the gate exists to avoid.
    expect(sourceHost("https://WWW.Example.com/story")).toBe("example.com");
    expect(sourceHost("https://www.example.com/story")).toBe("example.com");
  });

  it("strips only a LEADING www., because news.www.example.com is one host", () => {
    expect(sourceHost("https://news.www.example.com/x")).toBe("news.www.example.com");
  });

  it("keeps http, which the DTO allows beside https", () => {
    expect(sourceHost("http://example.com")).toBe("example.com");
  });

  it("answers null for null — a paste with no link has no host to show", () => {
    expect(sourceHost(null)).toBeNull();
  });

  it("answers null rather than throwing on a value no request could have stored", () => {
    // The DTO refuses these, and this app does not parse the api's body: a row
    // written by hand still has to draw a strip rather than blank the screen.
    expect(sourceHost("not a url")).toBeNull();
    expect(sourceHost("")).toBeNull();
    expect(sourceHost("mailto:someone@example.com")).toBeNull();
  });
});
