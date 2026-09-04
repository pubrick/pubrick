import { describe, expect, it } from "vitest";
import { MAX_TEST_CALLS_PER_HOUR } from "./ai-credentials.js";

/**
 * `MAX_TEST_CALLS_PER_HOUR`'s own doc comment and the commit that introduced
 * it sell a MAGNITUDE, not a mechanism: the Test button's hourly ceiling falls
 * from an unbounded ~$140/hour hole to "about $0.24 an hour". The rate-limit
 * *mechanism* — the window, the org scope, the ledger count — is well pinned
 * by `apps/api/src/ai-credentials/ai-credentials.e2e.spec.ts`, which seeds
 * exactly `MAX_TEST_CALLS_PER_HOUR` rows and asserts the boundary. But every
 * one of those tests, and the web assertion in
 * `apps/web/src/app/[locale]/settings/page.test.tsx` that interpolates the
 * constant into its expected sentence, moves right along with the constant's
 * *value* — changing 60 to 600, or 60,000, leaves all of them green.
 *
 * This pins the value by re-deriving the promise the commit message and the
 * changelog actually make, rather than asserting the literal `60`: a bare
 * `expect(MAX_TEST_CALLS_PER_HOUR).toBe(60)` is a change-detector that fires
 * on ANY edit to the constant, including a deliberate, reasoned one, and gives
 * the next reader no idea why 60 was the right number. Deriving worst-case
 * spend from the constant and holding it far below the pre-fix hole states the
 * actual claim: whatever the exact number is, it must keep this endpoint from
 * being a way to spend somebody else's money.
 */
describe("MAX_TEST_CALLS_PER_HOUR", () => {
  // The commit's own upper-bound estimate for one billed test call
  // ("$0.0004–$0.004 a press") — not re-derived from pricing, since the point
  // here is the RATIO to the hole this constant closed, not today's model
  // price.
  const MAX_COST_PER_TEST_CALL_USD = 0.004;

  // What an unthrottled loop could spend in an hour, per the commit message:
  // "a member with a loop at ten presses a second could spend on the order of
  // $140 an hour". Kept as a round, documented anchor rather than tuned to
  // today's exact figure.
  const PRE_FIX_HOURLY_SPEND_ESTIMATE_USD = 140;

  it("keeps worst-case hourly spend at least two orders of magnitude below the pre-fix hole", () => {
    const worstCaseHourlySpend = MAX_TEST_CALLS_PER_HOUR * MAX_COST_PER_TEST_CALL_USD;

    // A silent widening to 600 (worst case $2.40/hour) or to 60,000 (worst
    // case $240/hour) both fail this: the whole point of the limit is that it
    // is nowhere near the hole it closed.
    expect(worstCaseHourlySpend).toBeLessThan(PRE_FIX_HOURLY_SPEND_ESTIMATE_USD / 100);
  });

  it("is a positive, finite number of calls — not disabled by 0, Infinity or a fraction", () => {
    expect(MAX_TEST_CALLS_PER_HOUR).toBeGreaterThan(0);
    expect(Number.isInteger(MAX_TEST_CALLS_PER_HOUR)).toBe(true);
    expect(Number.isFinite(MAX_TEST_CALLS_PER_HOUR)).toBe(true);
  });
});
