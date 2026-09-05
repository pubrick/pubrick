import { describe, expect, it } from "vitest";
import {
  briefRunInputSchema,
  DISMISSABLE_RUN_STATUSES,
  isLiveRunStatus,
  LIVE_RUN_STATUSES,
  MAX_SOURCE_TEXT_LENGTH,
  RUN_STATUSES,
  runCreateSchema,
  runInputSchema,
  runStepCheckpointSchema,
  runStepsSchema,
  sourceRunInputSchema,
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
 * The second member of `pipeline_runs.input`, and the union that holds both.
 *
 * The bounds here mirror the brief member exactly — `.min(1)`, no `.max()` —
 * because the two arms describe the same column and the length limit lives on
 * `runCreateSchema`, the boundary a request crosses.
 */
describe("a run asked for from material a person pasted", () => {
  const channelIds = ["11111111-1111-4111-8111-111111111111"];
  const pasted = {
    kind: "source",
    text: null,
    sourceUrl: "https://example.com/autumn-menu",
    material: "The article, pasted in full.",
    channelIds,
  };

  it("accepts the shape the api writes for a paste with no brief", () => {
    expect(sourceRunInputSchema.parse(pasted)).toEqual(pasted);
  });

  it("accepts a paste with instructions, and a paste with no url", () => {
    const withBrief = { ...pasted, text: "Shorten it for our audience" };
    expect(sourceRunInputSchema.parse(withBrief)).toEqual(withBrief);
    const noUrl = { ...pasted, sourceUrl: null };
    expect(sourceRunInputSchema.parse(noUrl)).toEqual(noUrl);
  });

  /**
   * `null` and only `null` means "no brief". A stored `""` would reach the
   * worker as a labelled but empty BRIEF block — telling the model the person
   * wrote nothing USEFUL rather than that they wrote nothing — so it is not a
   * value this column may hold, and the writer's trim has this behind it.
   */
  it("refuses a stored empty brief, so blank can only be spelled null", () => {
    const denied = sourceRunInputSchema.safeParse({ ...pasted, text: "" });
    expect(denied.success).toBe(false);
    expect(denied.error?.issues.map((issue) => issue.path)).toEqual([["text"]]);
  });

  it("refuses material that is not there, exactly as the brief member does", () => {
    const denied = sourceRunInputSchema.safeParse({ ...pasted, material: "" });
    expect(denied.success).toBe(false);
    expect(denied.error?.issues.map((issue) => issue.path)).toEqual([["material"]]);
  });

  /**
   * The value is rendered as an `<a href>` on two screens and counted by 3b's
   * gate through `split_part(input->>'sourceUrl','://',2)`, which yields `''`
   * for a schemeless URL and is then dropped by `nullif` — an under-count
   * nothing would report. `z.url()` alone constrains no scheme in zod 4.
   */
  it("refuses a url whose scheme is not http or https", () => {
    // `httpx://` is what an unanchored `/^https?/` would let through.
    for (const sourceUrl of [
      "javascript:alert(1)",
      "mailto:someone@example.com",
      "httpx://example.com",
    ]) {
      const denied = sourceRunInputSchema.safeParse({ ...pasted, sourceUrl });
      expect(denied.success).toBe(false);
      expect(denied.error?.issues.map((issue) => issue.path)).toEqual([["sourceUrl"]]);
    }
    expect(
      sourceRunInputSchema.parse({ ...pasted, sourceUrl: "http://example.com" }).sourceUrl,
    ).toBe("http://example.com");
  });

  it("bounds a stored url at 2048 characters", () => {
    const path = "a".repeat(2048 - "http://x.io/".length);
    const atBound = `http://x.io/${path}`;
    expect(atBound.length).toBe(2048);
    expect(sourceRunInputSchema.parse({ ...pasted, sourceUrl: atBound }).sourceUrl).toBe(atBound);
    const denied = sourceRunInputSchema.safeParse({ ...pasted, sourceUrl: `${atBound}a` });
    expect(denied.success).toBe(false);
    expect(denied.error?.issues.map((issue) => issue.path)).toEqual([["sourceUrl"]]);
  });

  it("stores the paste unbounded: the length limit is the request's, not the column's", () => {
    const long = "x".repeat(MAX_SOURCE_TEXT_LENGTH + 1);
    expect(sourceRunInputSchema.parse({ ...pasted, material: long }).material).toBe(long);
  });

  it("reads both arms of the column, and refuses a kind no build has written", () => {
    const brief = { kind: "brief", text: "Announce the autumn menu", channelIds };
    expect(runInputSchema.parse(brief)).toEqual(brief);
    expect(runInputSchema.parse(pasted)).toEqual(pasted);
    expect(runInputSchema.safeParse({ ...brief, kind: "topic" }).success).toBe(false);
  });
});

/**
 * `POST /api/runs`' body. The bound and the cross-field refine live here, on the
 * boundary a request crosses: put on the stored member instead, the API would
 * admit an over-long paste, spend an admission slot, create the run and fail it
 * in the worker's parse.
 */
describe("what a run may be asked for", () => {
  const channelIds = ["11111111-1111-4111-8111-111111111111"];
  const brandId = "22222222-2222-4222-8222-222222222222";
  const base = { brandId, channelIds };

  it("accepts a brief alone, exactly as it did before material existed", () => {
    const body = { ...base, brief: "Announce the autumn menu" };
    expect(runCreateSchema.parse(body)).toEqual(body);
  });

  it("accepts material alone: a paste-only run has no brief to send", () => {
    const body = { ...base, material: "The article, pasted in full." };
    expect(runCreateSchema.parse(body)).toEqual(body);
  });

  it("accepts both, and the brief keeps its own meaning beside the paste", () => {
    const body = { ...base, brief: "Shorten it", material: "The article." };
    expect(runCreateSchema.parse(body)).toEqual(body);
  });

  /**
   * The bound is the create schema's and nothing else's: the same string the
   * request is refused for is a string the COLUMN may hold, because a stored
   * paste is a receipt of what was asked for rather than a request.
   */
  it("refuses a paste over the bound here, while the stored member takes it", () => {
    const long = "x".repeat(MAX_SOURCE_TEXT_LENGTH + 1);
    const denied = runCreateSchema.safeParse({ ...base, material: long });
    expect(denied.success).toBe(false);
    expect(denied.error?.issues.map((issue) => issue.path)).toEqual([["material"]]);
    expect(denied.error?.issues[0]?.code).toBe("too_big");
    expect(
      sourceRunInputSchema.parse({
        kind: "source",
        text: null,
        sourceUrl: null,
        material: long,
        channelIds,
      }).material,
    ).toBe(long);
  });

  it("accepts a paste of exactly the bound", () => {
    const atBound = "x".repeat(MAX_SOURCE_TEXT_LENGTH);
    expect(runCreateSchema.parse({ ...base, material: atBound }).material).toBe(atBound);
  });

  it("refuses a request with neither, naming both in one sentence", () => {
    const denied = runCreateSchema.safeParse(base);
    expect(denied.success).toBe(false);
    expect(denied.error?.issues.map((issue) => [issue.path, issue.message])).toEqual([
      [["brief"], "provide a brief, material, or both"],
    ]);
  });

  /**
   * The refine reads TRIMMED values, and the repository's writer branches on the
   * same two expressions. Two predicates that disagree about what "has material"
   * means is the defect; one, written once and read twice, is the fix.
   */
  it("reads both fields trimmed, so whitespace is not a thing to work from", () => {
    expect(
      runCreateSchema.parse({ ...base, brief: "   ", material: "The article." }).material,
    ).toBe("The article.");
    expect(runCreateSchema.parse({ ...base, brief: "A brief", material: "   " }).brief).toBe(
      "A brief",
    );
    const denied = runCreateSchema.safeParse({ ...base, brief: "   ", material: " \n " });
    expect(denied.success).toBe(false);
    expect(denied.error?.issues[0]?.message).toBe("provide a brief, material, or both");
  });

  it("refuses a source url whose scheme is not http or https", () => {
    for (const sourceUrl of [
      "javascript:alert(1)",
      "mailto:someone@example.com",
      "httpx://example.com",
    ]) {
      const denied = runCreateSchema.safeParse({ ...base, material: "The article.", sourceUrl });
      expect(denied.success).toBe(false);
      expect(denied.error?.issues.map((issue) => issue.path)).toEqual([["sourceUrl"]]);
    }
    expect(
      runCreateSchema.parse({
        ...base,
        material: "The article.",
        sourceUrl: "https://example.com/a",
      }).sourceUrl,
    ).toBe("https://example.com/a");
  });

  it("bounds a request's source url at 2048 characters", () => {
    const atBound = `http://x.io/${"a".repeat(2048 - "http://x.io/".length)}`;
    expect(
      runCreateSchema.parse({ ...base, material: "The article.", sourceUrl: atBound }).sourceUrl,
    ).toBe(atBound);
    const denied = runCreateSchema.safeParse({
      ...base,
      material: "The article.",
      sourceUrl: `${atBound}a`,
    });
    expect(denied.success).toBe(false);
    expect(denied.error?.issues.map((issue) => issue.path)).toEqual([["sourceUrl"]]);
  });

  /**
   * Normalise first, bound second — the rule `contentCreateSchema.body` already
   * follows, and the only pair of assertions that can tell the two orders apart:
   * a paste that fits once its CRLFs collapse must not be refused for characters
   * the product is about to drop anyway.
   */
  it("stores a paste's newlines as U+000A, and bounds what it stores", () => {
    expect(runCreateSchema.parse({ ...base, material: "One.\r\nTwo.\rThree." }).material).toBe(
      "One.\nTwo.\nThree.",
    );

    const crlf = Array(MAX_SOURCE_TEXT_LENGTH / 2)
      .fill("x")
      .join("\r\n");
    expect(crlf.length).toBe(MAX_SOURCE_TEXT_LENGTH + 3998);
    const accepted = runCreateSchema.parse({ ...base, material: crlf });
    expect(accepted.material?.length).toBe(MAX_SOURCE_TEXT_LENGTH - 1);
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
