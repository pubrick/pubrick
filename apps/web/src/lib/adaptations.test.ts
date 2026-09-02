import { DELIVERY_OUTCOMES } from "@pubrick/shared";
import { describe, expect, it } from "vitest";
import {
  ADAPTATION_STATUSES,
  CONTENT_STATUSES,
  DELIVERY_BADGE_STATUS,
  hasAdaptationInFlight,
  isAdaptationInFlight,
} from "./adaptations";

/**
 * What used to be here: a ratchet that read `apps/worker/src/publish/
 * publish.service.ts` off disk and asserted the English sentence this module
 * matched on was still spelled that way. It existed because nothing in the
 * response said whether a failed adaptation's send had actually left, so the
 * screen recognised an unknown delivery by `startsWith` on a log line, and a
 * reworded sentence would have turned every one of them back into a plain red
 * "Failed" with no test anywhere noticing.
 *
 * The api ships `deliveryOutcome` now, so there is no sentence to pin and
 * nothing to read the worker's source for. What is left to check is that the
 * values the wire can carry all have a color.
 */
describe("the unknown delivery outcome", () => {
  it("is the one outcome the adaptation column cannot hold", () => {
    expect(DELIVERY_OUTCOMES).toEqual([...ADAPTATION_STATUSES, "unknown"]);
  });

  it("gives every value the api can send a color, and no value it cannot", () => {
    expect(Object.keys(DELIVERY_BADGE_STATUS).sort()).toEqual([...DELIVERY_OUTCOMES].sort());
  });

  it("wears review's brick, not failed's red and not published's green", () => {
    expect(DELIVERY_BADGE_STATUS.unknown).toBe("review");
    expect(DELIVERY_BADGE_STATUS.unknown).not.toBe(DELIVERY_BADGE_STATUS.failed);
    expect(DELIVERY_BADGE_STATUS.unknown).not.toBe(DELIVERY_BADGE_STATUS.published);
  });
});

describe("what counts as in flight", () => {
  it("is exactly the two statuses the server moves on its own", () => {
    const inFlight = ADAPTATION_STATUSES.filter(isAdaptationInFlight);
    expect(inFlight).toEqual(["queued", "publishing"]);
  });

  it("leaves a scheduled adaptation out: its due time can be days away", () => {
    expect(isAdaptationInFlight("scheduled")).toBe(false);
    expect(hasAdaptationInFlight([{ status: "scheduled" }, { status: "pending" }])).toBe(false);
  });

  it("is true when any one adaptation of a fan-out is still going", () => {
    expect(
      hasAdaptationInFlight([{ status: "published" }, { status: "failed" }, { status: "queued" }]),
    ).toBe(true);
    expect(hasAdaptationInFlight([{ status: "published" }, { status: "failed" }])).toBe(false);
    expect(hasAdaptationInFlight([])).toBe(false);
  });
});

describe("the status unions", () => {
  it("keeps every content status colored", () => {
    expect(CONTENT_STATUSES).toEqual(["draft", "approved", "rejected", "published", "failed"]);
  });
});
