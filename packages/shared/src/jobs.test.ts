import { describe, expect, it } from "vitest";
import {
  PUBLISH_ABANDONED_AFTER_SECONDS,
  PUBLISH_ABANDONED_GRACE_SECONDS,
  PUBLISH_MAX_LATENESS_HOURS_DEFAULT,
  PUBLISH_POLLING_INTERVAL_SECONDS,
  PUBLISH_QUEUE_OPTIONS,
  PUBLISH_SUPERVISE_INTERVAL_SECONDS,
  SCHEDULED_DISPATCH_WINDOW_SECONDS,
  worstCaseSelfInflictedSeconds,
} from "./jobs.js";

/**
 * THE FLOOR UNDER `PUBLISH_MAX_LATENESS_HOURS`, as a test rather than as a
 * paragraph.
 *
 * The bound fails a post that reached the worker too late. If the queue's own
 * retry chain — plus the sweep that ends an attempt nobody came back from — can
 * itself burn more wall time than the bound, then the bound fails posts that
 * were merely RETRIED, silently, and the feature that exists to stop a silent
 * late post becomes a way to lose an on-time one. The relationship is derived,
 * so the tuning PR that raises `retryLimit` is what goes red.
 */
describe("the staleness bound is out of reach of the system's own delays", () => {
  it("leaves the default bound above every second the queue can spend on one job", () => {
    const floor =
      worstCaseSelfInflictedSeconds(PUBLISH_QUEUE_OPTIONS) + PUBLISH_ABANDONED_AFTER_SECONDS;
    expect(floor).toBeLessThan(PUBLISH_MAX_LATENESS_HOURS_DEFAULT * 3600);
  });

  /**
   * The margin, stated as the number it is. Not a second assertion of the line
   * above: a floor that crept from 3x to 1.02x of the bound would still pass it
   * while leaving no room at all for the parts of a delay this sum does not
   * model (a slow box, a database hiccup, a rolling deploy).
   */
  it("keeps a whole multiple of margin, not a hair", () => {
    const floor =
      worstCaseSelfInflictedSeconds(PUBLISH_QUEUE_OPTIONS) + PUBLISH_ABANDONED_AFTER_SECONDS;
    expect((PUBLISH_MAX_LATENESS_HOURS_DEFAULT * 3600) / floor).toBeGreaterThan(3);
  });

  /**
   * The arithmetic itself, on today's numbers, because a formula asserted only
   * against an inequality is a formula that can be wrong in the safe direction
   * for ever. Five retries at `retryDelay: 30` with backoff: 60 + 120 + 240 +
   * 480 + 960 = 1860s, `retryDelayMax: 3600` never binding; six attempts at
   * 600s + a 60s supervise interval = 3960s.
   */
  it("computes the chain pg-boss actually allows", () => {
    expect(worstCaseSelfInflictedSeconds(PUBLISH_QUEUE_OPTIONS)).toBe(1860 + 3960);
    expect(PUBLISH_SUPERVISE_INTERVAL_SECONDS).toBe(60);
  });

  /**
   * The cap is in the sum, not merely in the docstring: without it a raised
   * `retryLimit` would grow the backoff exponentially past a ceiling pg-boss
   * itself applies, and the floor would refuse a queue configuration that is
   * actually fine.
   */
  it("applies retryDelayMax to the backoff", () => {
    const capped = worstCaseSelfInflictedSeconds({
      retryLimit: 10,
      retryDelay: 30,
      retryDelayMax: 120,
      expireInSeconds: 0,
    });
    // 60 + 120, then the cap for the remaining eight.
    expect(capped).toBe(60 + 120 + 8 * 120 + 11 * PUBLISH_SUPERVISE_INTERVAL_SECONDS);
  });

  /**
   * A raised `retryLimit` is the mutation this file exists for. Ten retries
   * pushes the chain past six hours, and the assertion at the top is what turns
   * that into a red test rather than into posts that fail on a customer's
   * account.
   */
  it("goes red when the queue is tuned past the bound", () => {
    const tuned = { ...PUBLISH_QUEUE_OPTIONS, retryLimit: 10 };
    expect(
      worstCaseSelfInflictedSeconds(tuned) + PUBLISH_ABANDONED_AFTER_SECONDS,
    ).toBeGreaterThanOrEqual(PUBLISH_MAX_LATENESS_HOURS_DEFAULT * 3600);
  });

  /** The sweep's own derivation, kept where the queue options are. */
  it("derives the abandoned window from the attempt ceiling", () => {
    expect(PUBLISH_ABANDONED_GRACE_SECONDS).toBe(PUBLISH_QUEUE_OPTIONS.expireInSeconds);
    expect(PUBLISH_ABANDONED_AFTER_SECONDS).toBe(PUBLISH_QUEUE_OPTIONS.expireInSeconds * 2);
  });
});

/**
 * THE DISPATCH WINDOW — the margin a screen has to allow before it calls a
 * `scheduled` slot overdue.
 *
 * Derived, not chosen: the item screen's overdue alarm reads the BROWSER's
 * clock, so with no margin it fires for every healthy dispatch and for every
 * fast laptop clock. What it must outlast is this queue's own numbers — a poll,
 * an attempt's expiry, and the supervise interval it takes to notice one — and
 * it must stay far below the bound that actually FAILS a post, which is hours
 * and is the database's verdict rather than a browser's.
 */
describe("how long a scheduled slot may be past due and still be healthy", () => {
  it("outlasts a whole attempt the queue has not yet given up on", () => {
    expect(SCHEDULED_DISPATCH_WINDOW_SECONDS).toBeGreaterThan(
      PUBLISH_QUEUE_OPTIONS.expireInSeconds,
    );
    expect(SCHEDULED_DISPATCH_WINDOW_SECONDS).toBe(
      PUBLISH_POLLING_INTERVAL_SECONDS +
        PUBLISH_QUEUE_OPTIONS.expireInSeconds +
        PUBLISH_SUPERVISE_INTERVAL_SECONDS,
    );
  });

  /**
   * And it is a MARGIN, not a second verdict: the worker's bound is what fails
   * a post, and a window anywhere near it would have the screen calling an
   * outage on posts the system is still entitled to deliver.
   */
  it("stays far below the bound that fails a post", () => {
    expect(SCHEDULED_DISPATCH_WINDOW_SECONDS).toBeLessThan(
      (PUBLISH_MAX_LATENESS_HOURS_DEFAULT * 3600) / 10,
    );
  });
});
