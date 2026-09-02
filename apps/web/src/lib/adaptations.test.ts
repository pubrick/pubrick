import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADAPTATION_STATUSES,
  CONTENT_STATUSES,
  DELIVERY_BADGE_STATUS,
  deliveryOutcome,
  hasAdaptationInFlight,
  isAdaptationInFlight,
  isUnknownOutcome,
  UNKNOWN_OUTCOME_PREFIX,
} from "./adaptations";

describe("the unknown delivery outcome", () => {
  /**
   * The one coupling in this module, pinned against its source.
   *
   * `UNKNOWN_OUTCOME_PREFIX` is a copy of a sentence that lives in the worker,
   * and no type checks it: nothing in the content DTO says whether a failed
   * adaptation's send actually left. If someone rewords
   * `PublishService.recordUnknownOutcome`, every unknown outcome silently
   * becomes a plain red "Failed" again — the exact rounding this whole
   * distinction exists to prevent — and no test that mocks the api could
   * notice. So this one reads the worker's own source.
   *
   * It is a ratchet, not a design: the honest fix is an `outcome` field on the
   * adaptation DTO, which is an api change. Delete this test when that lands.
   */
  it("is spelled exactly as the worker writes it", () => {
    // Walked up from the working directory rather than resolved against
    // `import.meta.url`: vite rewrites that to a non-file URL, and a fixed
    // number of `..` segments assumes which package vitest was started from.
    const relative = join("apps", "worker", "src", "publish", "publish.service.ts");
    let directory = resolve(process.cwd());
    while (!existsSync(join(directory, relative))) {
      const parent = dirname(directory);
      if (parent === directory)
        throw new Error(`could not find ${relative} above ${process.cwd()}`);
      directory = parent;
    }
    const source = readFileSync(join(directory, relative), "utf8");
    expect(source).toContain(UNKNOWN_OUTCOME_PREFIX);
  });

  it("recognises the worker's sentence and nothing else", () => {
    expect(isUnknownOutcome(`${UNKNOWN_OUTCOME_PREFIX} the post was sent`)).toBe(true);
    expect(isUnknownOutcome("Unauthorized")).toBe(false);
    expect(isUnknownOutcome("")).toBe(false);
    expect(isUnknownOutcome(null)).toBe(false);
    // Not a substring match: a platform error that happens to quote the phrase
    // mid-sentence is still a plain failure, and the worker always leads with it.
    expect(isUnknownOutcome(`Telegram said: ${UNKNOWN_OUTCOME_PREFIX} nope`)).toBe(false);
  });

  it("is the only thing that turns a failed adaptation into an unknown one", () => {
    expect(deliveryOutcome({ status: "failed", lastError: "Unauthorized" })).toBe("failed");
    expect(
      deliveryOutcome({ status: "failed", lastError: `${UNKNOWN_OUTCOME_PREFIX} no answer` }),
    ).toBe("unknown");
    // A live row carrying the sentence from an earlier attempt is not unknown:
    // the current status is what happened, and it is still in flight.
    expect(
      deliveryOutcome({ status: "publishing", lastError: `${UNKNOWN_OUTCOME_PREFIX} no answer` }),
    ).toBe("publishing");
    expect(deliveryOutcome({ status: "published", lastError: null })).toBe("published");
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
