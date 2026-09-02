import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { createCallBudget } from "./budget.js";

/** Let pending timers and abort events run. */
async function tick(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createCallBudget", () => {
  it("attributes nothing while neither signal has fired", () => {
    const controller = new AbortController();
    const budget = createCallBudget(60_000, controller.signal);

    expect(budget.abortedBy()).toBeUndefined();
    expect(budget.signal.aborted).toBe(false);
    budget.release();
  });

  it("attributes the deadline to the timeout, even with a caller signal present", async () => {
    const controller = new AbortController();
    const budget = createCallBudget(5, controller.signal);

    await tick(30);

    expect(budget.signal.aborted).toBe(true);
    expect(budget.abortedBy()).toBe("timeout");
    budget.release();
  });

  it("attributes a caller's abort to the caller", async () => {
    const controller = new AbortController();
    const budget = createCallBudget(60_000, controller.signal);

    controller.abort();
    await tick(0);

    expect(budget.abortedBy()).toBe("caller");
    budget.release();
  });

  it("sees a caller signal that was ALREADY aborted, which fires no event", () => {
    // The common case rather than an edge one: the pre-dispatch check exists
    // for a caller that cancelled before the call started, and a listener added
    // to an aborted signal is never called.
    const controller = new AbortController();
    controller.abort();

    const budget = createCallBudget(60_000, controller.signal);

    expect(budget.abortedBy()).toBe("caller");
    budget.release();
  });

  it("keeps the FIRST signal that fired, not the last", async () => {
    // Both end up aborted: a caller pressing stop does not stop our timer. The
    // one that ended the call is the one that ended it.
    const controller = new AbortController();
    const budget = createCallBudget(20, controller.signal);

    controller.abort();
    await tick(60);

    expect(budget.signal.aborted).toBe(true);
    expect(budget.abortedBy()).toBe("caller");
    budget.release();
  });

  it("still attributes the timeout when no caller signal was given at all", async () => {
    const budget = createCallBudget(5);

    await tick(30);

    expect(budget.abortedBy()).toBe("timeout");
    budget.release();
  });

  it("leaves no listener behind on the caller's signal", () => {
    // That signal can outlive one model call by a whole worker process, so a
    // listener per call is an unbounded leak nothing else here would notice.
    const controller = new AbortController();
    const before = getEventListeners(controller.signal, "abort").length;

    const budget = createCallBudget(60_000, controller.signal);
    expect(getEventListeners(controller.signal, "abort").length).toBeGreaterThan(before);

    budget.release();

    expect(getEventListeners(controller.signal, "abort").length).toBe(before);
  });

  it("survives being released twice", () => {
    const controller = new AbortController();
    const budget = createCallBudget(60_000, controller.signal);
    budget.release();
    expect(() => {
      budget.release();
    }).not.toThrow();
  });
});
