import { describe, expect, it, vi } from "vitest";
import { onUnauthorized, reportUnauthorized } from "./unauthorized";

describe("the unauthorized signal", () => {
  it("tells every subscriber the server refused a request", () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = onUnauthorized(first);
    const stopSecond = onUnauthorized(second);

    reportUnauthorized();

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    stopFirst();
    stopSecond();
  });

  it("stops telling one that has unsubscribed", () => {
    // AppShell subscribes from an effect and returns this as its cleanup, so a
    // shell torn down by its own redirect must not be woken by the next 401.
    const listener = vi.fn();
    onUnauthorized(listener)();

    reportUnauthorized();

    expect(listener).not.toHaveBeenCalled();
  });

  it("survives a listener that unsubscribes itself while being called", () => {
    // Which is what the shell's own cleanup does when the redirect this signal
    // causes unmounts it. Everything queued behind it still gets told.
    const second = vi.fn();
    const stopFirst = onUnauthorized(() => stopFirst());
    const stopSecond = onUnauthorized(second);

    reportUnauthorized();

    expect(second).toHaveBeenCalledTimes(1);
    stopSecond();
  });
});
