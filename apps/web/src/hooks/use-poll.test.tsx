import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test/render";
import { POLL_HIDDEN_INTERVAL_MS, POLL_INTERVAL_MS, usePoll } from "./use-poll";

type Value = { status: "running" | "succeeded" };

const isTerminal = (value: Value) => value.status === "succeeded";
/** Never terminal — for the cases about timers rather than about stopping. */
const never = () => false;

function Probe({
  fetcher,
  terminal = isTerminal,
}: {
  fetcher: () => Promise<Value>;
  terminal?: (value: Value) => boolean;
}) {
  const { data, error, refresh } = usePoll(fetcher, terminal);
  return (
    <div>
      <span data-testid="status">{data?.status ?? "—"}</span>
      <span data-testid="error">{error instanceof Error ? error.message : "—"}</span>
      <button type="button" onClick={refresh}>
        refresh
      </button>
    </div>
  );
}

/** jsdom's `hidden` is a prototype getter; define an own property to control it. */
function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.dispatchEvent(new Event("visibilitychange"));
}

/**
 * Renders and flushes the immediate first fetch inside `act()`.
 *
 * The suite runs with ZERO act() warnings by policy, and this hook resolves a
 * promise straight out of its effect — so every flush in this file, timers
 * included, is wrapped.
 */
async function renderProbe(element: React.ReactElement) {
  const result = render(element);
  await act(async () => {});
  return result;
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  // Undo setHidden; deleting the own property restores jsdom's own getter.
  delete (document as unknown as Record<string, unknown>).hidden;
});

describe("usePoll", () => {
  it("fetches immediately and keeps polling while the value is not terminal", async () => {
    const fetcher = vi.fn<() => Promise<Value>>().mockResolvedValue({ status: "running" });

    await renderProbe(<Probe fetcher={fetcher} />);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("status")).toHaveTextContent("running");

    await advance(POLL_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(2);

    await advance(POLL_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("stops polling once the run reaches a terminal status", async () => {
    const fetcher = vi
      .fn<() => Promise<Value>>()
      .mockResolvedValueOnce({ status: "running" })
      .mockResolvedValue({ status: "succeeded" });

    await renderProbe(<Probe fetcher={fetcher} />);

    await advance(5 * POLL_INTERVAL_MS);

    // Two: the mount fetch, and the one that came back terminal. Not three —
    // a timer that survives the terminal status re-reads a run that will never
    // change again for as long as the receipt is on screen.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("status")).toHaveTextContent("succeeded");
  });

  it("clears its timer on unmount", async () => {
    const fetcher = vi.fn<() => Promise<Value>>().mockResolvedValue({ status: "running" });

    const { unmount } = await renderProbe(<Probe fetcher={fetcher} terminal={never} />);
    await advance(POLL_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(2);

    unmount();
    await advance(10 * POLL_INTERVAL_MS);

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("backs off while the tab is hidden, and catches up when it is shown again", async () => {
    const fetcher = vi.fn<() => Promise<Value>>().mockResolvedValue({ status: "running" });

    await renderProbe(<Probe fetcher={fetcher} terminal={never} />);
    expect(fetcher).toHaveBeenCalledTimes(1);

    act(() => setHidden(true));
    await advance(POLL_INTERVAL_MS);
    // The visible cadence has passed and nothing was fetched: a hidden tab has
    // no reader, and every poll costs a request.
    expect(fetcher).toHaveBeenCalledTimes(1);

    await advance(POLL_HIDDEN_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(2);

    act(() => setHidden(false));
    await advance(POLL_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("stops on an error, surfaces it, and resumes on refresh()", async () => {
    const fetcher = vi
      .fn<() => Promise<Value>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ status: "running" });

    await renderProbe(<Probe fetcher={fetcher} terminal={never} />);
    expect(screen.getByTestId("error")).toHaveTextContent("boom");

    await advance(10 * POLL_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "refresh" }));
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("error")).toHaveTextContent("—");
    await advance(POLL_INTERVAL_MS);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});
