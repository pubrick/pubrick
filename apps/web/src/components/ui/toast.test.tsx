import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "./toast";

function Trigger({ message, kind }: { message: string; kind?: "info" | "error" }) {
  const { show } = useToast();
  return (
    <button type="button" onClick={() => show(message, kind)}>
      Fire
    </button>
  );
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

    await act(async () => {
      screen.getByRole("button", { name: "Fire" }).click();
    });

    expect(screen.getByRole("status")).toHaveTextContent("Saved");
  });

  it("uses role=alert for kind=error", async () => {
    render(
      <ToastProvider>
        <Trigger message="Failed" kind="error" />
      </ToastProvider>,
    );

    await act(async () => {
      screen.getByRole("button", { name: "Fire" }).click();
    });

    expect(screen.getByRole("alert")).toHaveTextContent("Failed");
  });

  it("auto-dismisses after 4s", async () => {
    render(
      <ToastProvider>
        <Trigger message="Saved" />
      </ToastProvider>,
    );

    await act(async () => {
      screen.getByRole("button", { name: "Fire" }).click();
    });
    expect(screen.getByText("Saved")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(4000);
    });

    expect(screen.queryByText("Saved")).not.toBeInTheDocument();
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
