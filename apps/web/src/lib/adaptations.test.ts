import { DELIVERY_OUTCOMES } from "@pubrick/shared";
import { describe, expect, it } from "vitest";
import { POLL_INTERVAL_MS } from "@/hooks/use-poll";
import {
  ADAPTATION_STATUSES,
  CONTENT_BADGE_STATUS,
  CONTENT_LIST_POLL_INTERVAL_MS,
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
 *
 * ALSO DELETED, on 2026-09-04: "is the one outcome the adaptation column cannot
 * hold", which asserted `DELIVERY_OUTCOMES === [...ADAPTATION_STATUSES,
 * "unknown"]` while those were a web copy and a `@pubrick/shared` list. Both
 * names are the shared package's now and the union is literally that spread, so
 * the assertion compared a value with itself. The relation it guarded is
 * asserted where it can still fail — `packages/shared/src/dto/content.test.ts`,
 * "adds exactly one value to the adaptation column's own".
 */
describe("the unknown delivery outcome", () => {
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

/**
 * The list itself is `@pubrick/shared`'s and is asserted there. What only this
 * app can answer is whether every member of it has been given one of the five
 * colors — and the runtime check earns its place beside the `Record<
 * ContentStatus, …>` annotation, because this app resolves the shared package
 * from its BUILD: a stale `dist` type-checks against the old union while the
 * screen runs against the new list.
 */
describe("the status unions", () => {
  it("keeps every content status colored", () => {
    expect(Object.keys(CONTENT_BADGE_STATUS).sort()).toEqual([...CONTENT_STATUSES].sort());
  });
});

/**
 * The number itself is a tuning value and is deliberately NOT pinned: 5s or 6s
 * is a judgement about load, and a test that fails when someone changes it
 * asserts nothing except that nobody changed it. `content/page.test.tsx`
 * advances the clock BY this constant, so it proves the loop runs at whatever
 * the constant says and can never disagree with it.
 *
 * What is not a judgement is the RELATION the constant is documented by. This
 * list is polled by everyone with the main screen open; the item screen is
 * polled by the one person who just pressed the button. Setting the list to the
 * item screen's interval — or below it — multiplies the busiest screen's
 * request rate by the number of people watching, which is the one way to change
 * this number that is a defect rather than a preference.
 */
describe("how often the queue re-reads itself", () => {
  it("re-reads the LIST more slowly than the item screen re-reads one row", () => {
    expect(CONTENT_LIST_POLL_INTERVAL_MS).toBeGreaterThan(POLL_INTERVAL_MS);
  });
});
