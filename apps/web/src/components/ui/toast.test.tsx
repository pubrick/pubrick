import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import en from "../../../messages/en.json";
// The provider now renders a translated Close label, so it needs the app's
// intl provider around it — the shared render helper, not RTL's bare one.
import { render } from "../../test/render";
import { ToastProvider, useToast } from "./toast";

function Trigger({ message, kind }: { message: string; kind?: "info" | "error" }) {
  const { show } = useToast();
  return (
    <button type="button" onClick={() => show(message, kind)}>
      Fire
    </button>
  );
}

async function fire(): Promise<void> {
  await act(async () => {
    screen.getByRole("button", { name: "Fire" }).click();
  });
}

describe("Toast", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing until show() is called", () => {
    render(
      <ToastProvider>
        <Trigger message="Saved" />
      </ToastProvider>,
    );
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("shows the message with role=status for the default info kind", async () => {
    render(
      <ToastProvider>
        <Trigger message="Saved" />
      </ToastProvider>,
    );

    await fire();

    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });

  it("uses role=alert for kind=error", async () => {
    render(
      <ToastProvider>
        <Trigger message="Failed" kind="error" />
      </ToastProvider>,
    );

    await fire();

    expect(screen.getByRole("alert")).toHaveTextContent("Failed");
  });

  it("auto-dismisses an info toast after 4s", async () => {
    render(
      <ToastProvider>
        <Trigger message="Saved" />
      </ToastProvider>,
    );

    await fire();
    expect(screen.getByText("Saved")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(4000);
    });

    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("clears the pending auto-dismiss timer on unmount — no leaked timer", async () => {
    const { unmount } = render(
      <ToastProvider>
        <Trigger message="Saved" />
      </ToastProvider>,
    );

    await fire();
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("throws when useToast is called outside a ToastProvider", () => {
    // Swallow the expected React error-boundary console noise for this one assertion.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Bare() {
      useToast();
      return null;
    }
    expect(() => render(<Bare />)).toThrow(/useToast must be used within a ToastProvider/);
    spy.mockRestore();
  });
});

/**
 * Four seconds is a glance, and a toast that takes itself away mid-sentence is
 * a message that was never really delivered. Two rules, both about the reader
 * rather than the clock.
 */
describe("Toast — time belongs to the reader", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("never auto-dismisses an error, however long you leave it", async () => {
    render(
      <ToastProvider>
        <Trigger message="Publishing failed" kind="error" />
      </ToastProvider>,
    );

    await fire();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Publishing failed");
  });

  it("gives the error a way out — the Close button dismisses it", async () => {
    render(
      <ToastProvider>
        <Trigger message="Publishing failed" kind="error" />
      </ToastProvider>,
    );
    await fire();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.Ui.close }));
    });

    expect(screen.queryByText("Publishing failed")).not.toBeInTheDocument();
  });

  it("pauses the countdown while the pointer rests on the toast", async () => {
    render(
      <ToastProvider>
        <Trigger message="Saved" />
      </ToastProvider>,
    );
    await fire();
    const region = screen.getByRole("status").parentElement as HTMLElement;

    await act(async () => {
      vi.advanceTimersByTime(2000);
      fireEvent.mouseEnter(region);
    });
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });

    expect(screen.getByText("Saved")).toBeInTheDocument();
  });

  it("resumes with the time it had LEFT, not a fresh four seconds", async () => {
    render(
      <ToastProvider>
        <Trigger message="Saved" />
      </ToastProvider>,
    );
    await fire();
    const region = screen.getByRole("status").parentElement as HTMLElement;

    // 3s spent, 1s owed. Hover, wait a long time, leave.
    await act(async () => {
      vi.advanceTimersByTime(3000);
      fireEvent.mouseEnter(region);
      vi.advanceTimersByTime(30_000);
      fireEvent.mouseLeave(region);
    });

    // Not yet: the second still has to pass.
    await act(async () => {
      vi.advanceTimersByTime(900);
    });
    expect(screen.getByText("Saved")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
  });

  it("pauses on focus too — reaching the Close button by keyboard stops the clock", async () => {
    render(
      <ToastProvider>
        <Trigger message="Saved" />
      </ToastProvider>,
    );
    await fire();

    await act(async () => {
      vi.advanceTimersByTime(2000);
      screen.getByRole("button", { name: en.Ui.close }).focus();
    });
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });

    expect(screen.getByText("Saved")).toBeInTheDocument();
  });
});
