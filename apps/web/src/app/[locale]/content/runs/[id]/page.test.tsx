import { runDetailDtoSchema, type SourceRunInput } from "@pubrick/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLL_INTERVAL_MS } from "@/hooks/use-poll";
import type { RunDetail, RunStatus } from "@/lib/runs";
import { signedInSession } from "@/test/auth-client.stub";
import { routerMock } from "@/test/next-navigation.stub";
import { act, fireEvent, renderAsync, screen, waitFor, within } from "@/test/render";
import en from "../../../../../../messages/en.json";
import RunPage from "./page";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: vi.fn() };
});

// Imported after the mock so this binding is the mocked export.
import { api } from "@/lib/api";

const mockApi = vi.mocked(api);

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ITEM_ID = "22222222-2222-4222-8222-222222222222";
const CHANNEL_A = "33333333-3333-4333-8333-333333333333";
const CHANNEL_B = "44444444-4444-4444-8444-444444444444";

/**
 * A run as the api returns it — PARSED through the wire schema the api's own
 * e2e parses a real response body with, not merely typed as it. A fixture that
 * is only typed can carry a field the api never sends (it did: the receipt
 * was written against a `RunDetail` the allowlist did not fully return), and
 * a fixture that is only hand-written can omit one. This one fails to build
 * unless it is a body the api could have produced.
 */
function makeRun(overrides: Partial<RunDetail> = {}): RunDetail {
  return runDetailDtoSchema.parse({
    id: RUN_ID,
    brandId: "55555555-5555-4555-8555-555555555555",
    input: { kind: "brief", text: "A post about our new pricing", channelIds: [CHANNEL_A] },
    status: "running" as RunStatus,
    currentStep: "researcher",
    contentItemId: null,
    errorCode: null,
    dismissedAt: null,
    unrecordedCalls: 0,
    steps: {},
    createdAt: "2026-08-28T10:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
    ...overrides,
  });
}

type Call = { path: string; method: string };

/** Answers `GET /api/runs/:id` from `served`, recording every call. */
function installHandlers(served: { current: RunDetail }, calls: Call[] = []) {
  mockApi.mockImplementation(async (...args: unknown[]) => {
    const path = args[0] as string;
    const init = args[1] as RequestInit | undefined;
    const method = init?.method ?? "GET";
    calls.push({ path, method });
    if (path === `/api/runs/${RUN_ID}/cancel` && method === "POST") {
      served.current = { ...served.current, status: "cancelled" };
      return served.current;
    }
    if (path === `/api/runs/${RUN_ID}` && method === "GET") return served.current;
    throw new Error(`unhandled request in test: ${method} ${path}`);
  });
  return calls;
}

const renderRun = () => renderAsync(<RunPage params={Promise.resolve({ id: RUN_ID })} />);

beforeEach(() => {
  mockApi.mockReset();
  signedInSession();
});

describe("the step checklist", () => {
  it("derives each step's state from the run's checkpoints", async () => {
    installHandlers({
      current: makeRun({
        currentStep: "editor",
        steps: { researcher: { status: "succeeded" }, writer: { status: "succeeded" } },
        input: { kind: "brief", text: "Brief text", channelIds: [CHANNEL_A, CHANNEL_B] },
      }),
    });

    await renderRun();

    const rows = await screen.findAllByRole("listitem");
    const labelled = (label: string) =>
      rows.find((row) => row.textContent?.startsWith(label)) as HTMLElement;

    expect(labelled(en.Runs.step.researcher)).toHaveTextContent(en.Runs.stepState.done);
    expect(labelled(en.Runs.step.writer)).toHaveTextContent(en.Runs.stepState.done);
    expect(labelled(en.Runs.step.editor)).toHaveTextContent(en.Runs.stepState.active);
    expect(labelled(en.Runs.step.factcheck)).toHaveTextContent(en.Runs.stepState.pending);
    // The fan-out is one row with a count, not one row per channel.
    expect(labelled(en.Runs.step.adapter)).toHaveTextContent("0 of 2 channels");
  });

  it("shows the brief the run was started from", async () => {
    installHandlers({ current: makeRun() });

    await renderRun();

    expect(await screen.findByText("A post about our new pricing")).toBeInTheDocument();
  });

  it("marks the step the run died on as failed and shows the run's own error", async () => {
    installHandlers({
      current: makeRun({
        status: "failed",
        currentStep: "writer",
        steps: { researcher: { status: "succeeded" } },
        errorCode: "too_long_for_channel",
      }),
    });

    await renderRun();

    // Our sentence for the code, in the reader's language — the provider's own
    // words never get this far, because they are where an API key gets quoted.
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(en.Runs.failure.too_long_for_channel);

    const rows = screen.getAllByRole("listitem");
    const writerRow = rows.find((row) => row.textContent?.startsWith(en.Runs.step.writer));
    expect(writerRow).toHaveTextContent(en.Runs.stepState.failed);
    // A failed run produced no draft, so there is nothing to open.
    expect(screen.queryByRole("link", { name: en.Runs.draftReady })).not.toBeInTheDocument();
  });
});

describe("a run that is over does not claim anything is still coming", () => {
  it("reads a failed run's un-reached steps as not run, never as waiting", async () => {
    installHandlers({
      current: makeRun({
        status: "failed",
        currentStep: "writer",
        steps: { researcher: { status: "succeeded" } },
        errorCode: "provider_refused",
      }),
    });

    await renderRun();

    const rows = await screen.findAllByRole("listitem");
    const row = (label: string) =>
      rows.find((r) => r.textContent?.startsWith(label)) as HTMLElement;

    // "Waiting" promises the step is still going to run. Nothing is going to
    // run: the run is over.
    expect(screen.queryByText(en.Runs.stepState.pending)).not.toBeInTheDocument();
    expect(row(en.Runs.step.editor)).toHaveTextContent(en.Runs.stepState.skipped);
    expect(row(en.Runs.step.factcheck)).toHaveTextContent(en.Runs.stepState.skipped);
    expect(row(en.Runs.step.adapter)).toHaveTextContent(en.Runs.stepState.skipped);
    // ...and what DID happen before the failure still reads as it happened.
    expect(row(en.Runs.step.researcher)).toHaveTextContent(en.Runs.stepState.done);
    expect(row(en.Runs.step.writer)).toHaveTextContent(en.Runs.stepState.failed);
  });

  it("shows four done and one failed when a run dies at the fan-out", async () => {
    installHandlers({
      current: makeRun({
        status: "failed",
        currentStep: `adapter:${CHANNEL_A}`,
        steps: {
          researcher: { status: "succeeded" },
          writer: { status: "succeeded" },
          editor: { status: "succeeded" },
          factcheck: { status: "succeeded" },
        },
        errorCode: "too_long_for_channel",
      }),
    });

    await renderRun();

    const rows = await screen.findAllByRole("listitem");
    const states = rows.map((r) => r.textContent ?? "");
    expect(states.filter((t) => t.includes(en.Runs.stepState.done))).toHaveLength(4);
    expect(states.filter((t) => t.includes(en.Runs.stepState.failed))).toHaveLength(1);
    expect(states.filter((t) => t.includes(en.Runs.stepState.pending))).toHaveLength(0);
  });

  it("still reads a queued run's steps as waiting — nothing is over there", async () => {
    installHandlers({ current: makeRun({ status: "queued", currentStep: null }) });

    await renderRun();

    const rows = await screen.findAllByRole("listitem");
    expect(rows.filter((r) => r.textContent?.includes(en.Runs.stepState.pending))).toHaveLength(5);
    expect(screen.queryByText(en.Runs.stepState.skipped)).not.toBeInTheDocument();
  });
});

describe("the finished draft is offered, never forced", () => {
  it("shows a Draft ready link on a run that was already finished", async () => {
    installHandlers({
      current: makeRun({ status: "succeeded", currentStep: null, contentItemId: ITEM_ID }),
    });

    await renderRun();

    const link = await screen.findByRole("link", { name: en.Runs.draftReady });
    expect(link).toHaveAttribute("href", `/en/content/${ITEM_ID}`);
  });

  /**
   * The promise this increment exists to keep.
   *
   * `first_opened_at` is the publish gate's evidence that a human read the
   * draft, and the item page stamps it on render. A redirect fired when the
   * poll sees `succeeded` would therefore satisfy that signal with no human
   * involved — the gate would still be enforced server-side and would still be
   * decoration. This test fails the moment a `router.push`/`replace` is added
   * to the success path.
   */
  it("does NOT navigate to the draft when the run finishes while being watched", async () => {
    vi.useFakeTimers();
    try {
      const running = makeRun({ currentStep: "editor" });
      const served = { current: running };
      installHandlers(served);

      await renderRun();
      expect(screen.queryByRole("link", { name: en.Runs.draftReady })).not.toBeInTheDocument();

      served.current = makeRun({
        status: "succeeded",
        currentStep: null,
        contentItemId: ITEM_ID,
        steps: {
          researcher: { status: "succeeded" },
          writer: { status: "succeeded" },
          editor: { status: "succeeded" },
          factcheck: { status: "succeeded" },
          [`adapter:${CHANNEL_A}`]: { status: "succeeded" },
        },
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
      });

      // The link is there, and it is a link…
      expect(screen.getByRole("link", { name: en.Runs.draftReady })).toHaveAttribute(
        "href",
        `/en/content/${ITEM_ID}`,
      );
      // …and nothing followed it on the reader's behalf.
      expect(routerMock.push).not.toHaveBeenCalled();
      expect(routerMock.replace).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * The step whose whole purpose is honesty about what it could NOT verify.
 *
 * Its list is generated, billed and stored on the run; until this it was
 * rendered nowhere, so the one step that exists to say "I could not check
 * these" was the one step whose output nobody could read. The heading it
 * appears under is `Runs.step.factcheck`, pinned to `CLAIMS_TO_VERIFY_LABEL`
 * by `src/test/factcheck-label.test.ts` — the same phrase the step's own
 * prompt promises the model the list will be shown under.
 */
describe("the claims the run listed", () => {
  const CLAIMS = [
    { text: "Revenue tripled in the second quarter.", needsCheck: true },
    { text: "Our office is in Lisbon.", needsCheck: false },
  ];

  /** The `factcheck` row, which is the heading this list lives under. */
  const factcheckRow = async () => {
    const rows = await screen.findAllByRole("listitem");
    return rows.find((row) => row.textContent?.startsWith(en.Runs.step.factcheck)) as HTMLElement;
  };

  it("renders every claim under the fact-check heading", async () => {
    installHandlers({
      current: makeRun({
        status: "succeeded",
        currentStep: null,
        contentItemId: ITEM_ID,
        steps: { factcheck: { status: "succeeded", output: { claims: CLAIMS } } },
      }),
    });

    await renderRun();

    const row = await factcheckRow();
    // Under the heading, not merely somewhere on the page: a claims list that
    // floated free of the step that produced it would be a second, unlabelled
    // place for the same thing.
    for (const claim of CLAIMS) expect(within(row).getByText(claim.text)).toBeInTheDocument();
    // ...and the flagged one is marked as worth a human's time, while the one
    // the model called common knowledge carries no marker of its own.
    expect(within(row).getAllByText(en.Runs.claimNeedsCheck)).toHaveLength(1);
    expect(row).not.toHaveTextContent(en.Runs.claimsEmpty);
  });

  /**
   * "It ran and listed nothing" and "it never ran" are different sentences, and
   * this screen must not use one for the other. An empty list is a real,
   * paid-for outcome — a post can make no factual claim at all — and printing
   * nothing for it is indistinguishable from a step that never happened.
   */
  it("says the list was empty when the step ran and listed nothing", async () => {
    installHandlers({
      current: makeRun({
        status: "succeeded",
        currentStep: null,
        contentItemId: ITEM_ID,
        steps: { factcheck: { status: "succeeded", output: { claims: [] } } },
      }),
    });

    await renderRun();

    const row = await factcheckRow();
    expect(row).toHaveTextContent(en.Runs.claimsEmpty);
    expect(row).toHaveTextContent(en.Runs.stepState.done);
  });

  /** ...and the run that died before the step gets NEITHER. */
  it("claims nothing about a run that never reached the fact-checker", async () => {
    installHandlers({
      current: makeRun({
        status: "failed",
        currentStep: "writer",
        steps: { researcher: { status: "succeeded" } },
        errorCode: "provider_refused",
      }),
    });

    await renderRun();

    const row = await factcheckRow();
    // Not "found nothing to flag" — nothing was looked for. The badge is the
    // only thing this row is entitled to say.
    expect(screen.queryByText(en.Runs.claimsEmpty)).not.toBeInTheDocument();
    expect(row).toHaveTextContent(en.Runs.stepState.skipped);
  });

  it("shows nothing rather than junk when the stored output cannot be read", async () => {
    // `steps` is jsonb written by whatever worker build was deployed; an older
    // shape must not become a rendered artefact or an empty-list claim.
    installHandlers({
      current: makeRun({
        status: "succeeded",
        currentStep: null,
        contentItemId: ITEM_ID,
        steps: { factcheck: { status: "succeeded", output: { claims: "one, two" } } },
      }),
    });

    await renderRun();

    const row = await factcheckRow();
    expect(row).not.toHaveTextContent(en.Runs.claimsEmpty);
    expect(row).not.toHaveTextContent("one, two");
  });
});

describe("what the editor changed", () => {
  const editorRow = async () => {
    const rows = await screen.findAllByRole("listitem");
    return rows.find((row) => row.textContent?.startsWith(en.Runs.step.editor)) as HTMLElement;
  };

  it("lists the editor's own change notes under its step", async () => {
    const changes = ["Cut the closing paragraph.", "Tightened the opening line."];
    installHandlers({
      current: makeRun({
        status: "succeeded",
        currentStep: null,
        contentItemId: ITEM_ID,
        steps: {
          editor: { status: "succeeded", output: { body: "The edited post", changes } },
        },
      }),
    });

    await renderRun();

    const row = await editorRow();
    for (const change of changes) expect(within(row).getByText(change)).toBeInTheDocument();
    // The checkpoint also holds the edited BODY. The receipt says what happened
    // to the post; the post itself lives on the item screen, where it can be
    // edited, and a frozen second copy here would be a rival to it.
    expect(screen.queryByText("The edited post")).not.toBeInTheDocument();
  });

  it("says the editor changed nothing rather than falling silent", async () => {
    installHandlers({
      current: makeRun({
        status: "succeeded",
        currentStep: null,
        contentItemId: ITEM_ID,
        steps: { editor: { status: "succeeded", output: { body: "Body", changes: [] } } },
      }),
    });

    await renderRun();

    expect(await editorRow()).toHaveTextContent(en.Runs.changesEmpty);
  });
});

/**
 * The other half of "the receipt stays reachable from the finished item": a run
 * whose item is gone.
 *
 * `pipeline_runs.content_item_id` is ON DELETE SET NULL, because a run is the
 * record of what was spent and outlives the draft it bought. So a SUCCEEDED run
 * with no item did produce one and no longer has it — the only way to reach
 * that state — and saying so is better than an empty space where the link was.
 */
describe("a succeeded run whose draft is gone", () => {
  it("says the draft was deleted instead of silently dropping the link", async () => {
    installHandlers({
      current: makeRun({ status: "succeeded", currentStep: null, contentItemId: null }),
    });

    await renderRun();

    expect(await screen.findByText(en.Runs.draftDeleted)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: en.Runs.draftReady })).not.toBeInTheDocument();
  });

  it("says it only about a run that HAD a draft — never about one that failed", async () => {
    installHandlers({
      current: makeRun({ status: "failed", currentStep: "writer", errorCode: "internal" }),
    });

    await renderRun();

    // "Failed" is on the run's badge AND on the step's, so wait on the run's
    // own failure sentence instead — it exists exactly once.
    await screen.findByText(en.Runs.failure.internal);
    expect(screen.queryByText(en.Runs.draftDeleted)).not.toBeInTheDocument();
  });
});

describe("cancelling", () => {
  it("cancels a running run and re-reads it", async () => {
    const calls: Call[] = [];
    installHandlers({ current: makeRun() }, calls);

    await renderRun();
    const cancel = await screen.findByRole("button", { name: en.Runs.cancel });

    await act(async () => {
      fireEvent.click(cancel);
    });

    expect(calls.some((c) => c.method === "POST" && c.path === `/api/runs/${RUN_ID}/cancel`)).toBe(
      true,
    );
    await waitFor(() => expect(screen.getByText(en.Runs.status.cancelled)).toBeInTheDocument());
  });

  it("offers no Cancel once the run has stopped", async () => {
    installHandlers({ current: makeRun({ status: "cancelled", currentStep: null }) });

    await renderRun();

    await screen.findByText(en.Runs.status.cancelled);
    expect(screen.queryByRole("button", { name: en.Runs.cancel })).not.toBeInTheDocument();
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * `unrecordedCalls` — billed model calls the ledger refused — carries THREE
 * values, and this receipt is the one place a person is told about a loss on
 * their run. Zero and NULL must not render alike: NULL is a run from before
 * the counter existed, and rendering it as "nothing lost" is the product
 * asserting the one thing it cannot know about exactly those runs.
 */
describe("calls the ledger could not record", () => {
  const lossSentence = (count: number) => new RegExp(`${count} .*could not be recorded`, "i");

  it("says how many, as an alert, and that the spend figure is short by them", async () => {
    installHandlers({ current: makeRun({ status: "succeeded", unrecordedCalls: 3 }) });

    await renderRun();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(lossSentence(3));
    expect(alert).toHaveTextContent(/settings/i);
    expect(screen.queryByText(en.Runs.unrecordedUnknown)).not.toBeInTheDocument();
  });

  it("says one call in the singular", async () => {
    installHandlers({ current: makeRun({ status: "succeeded", unrecordedCalls: 1 }) });

    await renderRun();

    expect(await screen.findByRole("alert")).toHaveTextContent(/1 model call .*could not be/i);
  });

  it("says nothing at all for zero: every call reached the ledger", async () => {
    installHandlers({ current: makeRun({ status: "succeeded", unrecordedCalls: 0 }) });

    await renderRun();

    await screen.findByText(en.Runs.status.succeeded);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(en.Runs.unrecordedUnknown)).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be recorded/i)).not.toBeInTheDocument();
  });

  it("says that nothing is known for NULL — never that nothing was lost", async () => {
    installHandlers({ current: makeRun({ status: "succeeded", unrecordedCalls: null }) });

    await renderRun();

    const note = await screen.findByText(en.Runs.unrecordedUnknown);
    // Not an alert: a run predating the counter is not a failure of this run,
    // and the sentence is a statement of ignorance, not of a loss.
    expect(note).not.toHaveAttribute("role", "alert");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/could not be recorded/i)).not.toBeInTheDocument();
  });

  it("is a field the api MUST return: a fixture without it cannot be built", () => {
    // The receipt's fixture is parsed with the api's wire schema. Dropping the
    // column from the api's allowlist fails the api's e2e on this schema; a
    // fixture here that quietly leaves it out fails the same way.
    const { unrecordedCalls: _dropped, ...without } = makeRun();
    expect(() => runDetailDtoSchema.parse(without)).toThrow();
  });
});

/**
 * The receipt of a run that was drafted from pasted material.
 *
 * `run.input` is a union and BOTH arms carry `text`, so none of this is a
 * compile error: a receipt with no branch renders `run.input.text` for a source
 * run exactly as it does for a brief one, and for a paste-only run that is an
 * empty labelled block — the screen saying "the person wrote nothing useful"
 * about a person who wrote nothing. Only a test can find that, so these are it.
 */
describe("a run drafted from pasted material", () => {
  const MATERIAL = "The council voted on Tuesday to fund the bridge.";

  /** Built through the wire schema like every other fixture here. */
  function sourceRun(overrides: Partial<SourceRunInput> = {}): RunDetail {
    return makeRun({
      input: {
        kind: "source",
        text: null,
        sourceUrl: null,
        material: MATERIAL,
        channelIds: [CHANNEL_A],
        ...overrides,
      },
    });
  }

  it("shows the material it was drafted from, under its own label", async () => {
    installHandlers({ current: sourceRun() });

    await renderRun();

    expect(await screen.findByText(en.Runs.materialLabel)).toBeInTheDocument();
    expect(screen.getByText(MATERIAL)).toBeInTheDocument();
  });

  it("says there was no brief instead of labelling an empty one", async () => {
    installHandlers({ current: sourceRun() });

    const { container } = await renderRun();

    expect(await screen.findByText(en.Runs.noBrief)).toBeInTheDocument();
    // The label with nothing under it is the defect this line replaces.
    expect(screen.queryByText(en.Runs.briefLabel)).not.toBeInTheDocument();
    // ...and `text: null` is never printed AS a value: `{null}` renders
    // nothing, `String(null)` renders the word, and both type-check.
    expect(container.textContent).not.toContain("null");
  });

  it("keeps the brief when the person wrote one beside the paste", async () => {
    installHandlers({ current: sourceRun({ text: "Keep it under 200 words" }) });

    await renderRun();

    expect(await screen.findByText("Keep it under 200 words")).toBeInTheDocument();
    expect(screen.getByText(en.Runs.briefLabel)).toBeInTheDocument();
    expect(screen.queryByText(en.Runs.noBrief)).not.toBeInTheDocument();
    // Both, not one instead of the other: the brief is an instruction ABOUT the
    // material, so a receipt showing only it would not say what was worked from.
    expect(screen.getByText(MATERIAL)).toBeInTheDocument();
  });

  it("links the source URL, and asks the network for nothing but the run", async () => {
    const calls: Call[] = [];
    installHandlers({ current: sourceRun({ sourceUrl: "https://example.com/story" }) }, calls);

    await renderRun();

    const link = await screen.findByRole("link", { name: "https://example.com/story" });
    expect(link).toHaveAttribute("href", "https://example.com/story");
    // A link out of this app must not hand the destination a handle on this
    // window, or this app's URL.
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    // The URL is attribution and is NEVER fetched — not by the server, and not
    // by the screen that shows it.
    expect(calls.map((c) => c.path)).toEqual([`/api/runs/${RUN_ID}`]);
  });

  it("shows no source line at all when the paste came with no link", async () => {
    installHandlers({ current: sourceRun() });

    await renderRun();

    expect(await screen.findByText(en.Runs.materialLabel)).toBeInTheDocument();
    // An empty "Source" is the same defect as an empty "Brief".
    expect(screen.queryByText(en.Runs.sourceLabel)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /example\.com/ })).not.toBeInTheDocument();
  });

  it("leaves a brief run's receipt exactly as it was", async () => {
    installHandlers({ current: makeRun() });

    await renderRun();

    expect(await screen.findByText("A post about our new pricing")).toBeInTheDocument();
    expect(screen.getByText(en.Runs.briefLabel)).toBeInTheDocument();
    expect(screen.queryByText(en.Runs.materialLabel)).not.toBeInTheDocument();
    expect(screen.queryByText(en.Runs.sourceLabel)).not.toBeInTheDocument();
    expect(screen.queryByText(en.Runs.noBrief)).not.toBeInTheDocument();
  });
});
