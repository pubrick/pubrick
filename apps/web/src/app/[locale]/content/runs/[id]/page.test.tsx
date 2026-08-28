import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLL_INTERVAL_MS } from "@/hooks/use-poll";
import type { RunDetail, RunStatus } from "@/lib/runs";
import { signedInSession } from "@/test/auth-client.stub";
import { routerMock } from "@/test/next-navigation.stub";
import { act, fireEvent, renderAsync, screen, waitFor } from "@/test/render";
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

function makeRun(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    id: RUN_ID,
    brandId: "55555555-5555-4555-8555-555555555555",
    input: { kind: "brief", text: "A post about our new pricing", channelIds: [CHANNEL_A] },
    status: "running" as RunStatus,
    currentStep: "researcher",
    contentItemId: null,
    error: null,
    dismissedAt: null,
    steps: {},
    createdAt: "2026-08-28T10:00:00.000Z",
    updatedAt: "2026-08-28T10:00:00.000Z",
    ...overrides,
  };
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
        error: "The model could not fit Telegram's limit",
      }),
    });

    await renderRun();

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The model could not fit Telegram's limit");

    const rows = screen.getAllByRole("listitem");
    const writerRow = rows.find((row) => row.textContent?.startsWith(en.Runs.step.writer));
    expect(writerRow).toHaveTextContent(en.Runs.stepState.failed);
    // A failed run produced no draft, so there is nothing to open.
    expect(screen.queryByRole("link", { name: en.Runs.draftReady })).not.toBeInTheDocument();
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
