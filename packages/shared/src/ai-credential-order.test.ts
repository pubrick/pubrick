import { describe, expect, it } from "vitest";
import { compareCredentialOrder, preferredCredential } from "./ai-credential-order.js";

/** A row in the shape both repositories select, with a `createdAt` we control. */
function row(provider: "google" | "openrouter", isoDate: string, tag = provider) {
  return { provider, createdAt: new Date(isoDate), tag };
}

const OLD = "2026-01-01T00:00:00.000Z";
const NEW = "2026-06-01T00:00:00.000Z";

/**
 * The rule two apps obey. What is tested here is not "it sorts" — it is the one
 * property the split cannot preserve by accident: given the same rows, the api
 * and the worker reach the same key.
 */
describe("compareCredentialOrder", () => {
  it("puts the older credential first, whichever way round it is asked", () => {
    const older = row("openrouter", OLD);
    const newer = row("google", NEW);
    expect(compareCredentialOrder(older, newer)).toBeLessThan(0);
    expect(compareCredentialOrder(newer, older)).toBeGreaterThan(0);
  });

  it("falls back to provider ascending when the timestamps are equal", () => {
    const google = row("google", OLD);
    const openrouter = row("openrouter", OLD);
    expect(compareCredentialOrder(google, openrouter)).toBeLessThan(0);
    expect(compareCredentialOrder(openrouter, google)).toBeGreaterThan(0);
  });

  it("calls a row equal to itself", () => {
    expect(compareCredentialOrder(row("google", OLD), row("google", OLD))).toBe(0);
  });

  /**
   * A millisecond is a real difference, and the rows this orders are written by
   * `defaultNow()` — two keys saved in one sitting are seconds apart at most.
   * An ordering that compared dates at second granularity would look right on
   * every fixture anyone would think to write and coin-flip on live data.
   */
  it("separates rows a single millisecond apart", () => {
    const first = row("openrouter", "2026-01-01T00:00:00.000Z");
    const second = row("google", "2026-01-01T00:00:00.001Z");
    expect(compareCredentialOrder(first, second)).toBeLessThan(0);
  });
});

describe("preferredCredential", () => {
  it("picks the oldest credential, whatever order the rows arrive in", () => {
    const older = row("openrouter", OLD);
    const newer = row("google", NEW);
    expect(preferredCredential([older, newer])).toBe(older);
    expect(preferredCredential([newer, older])).toBe(older);
  });

  it("breaks a tie on provider ascending — google before openrouter", () => {
    const google = row("google", OLD);
    const openrouter = row("openrouter", OLD);
    expect(preferredCredential([google, openrouter])).toBe(google);
    expect(preferredCredential([openrouter, google])).toBe(google);
  });

  it("returns the single row unchanged", () => {
    const only = row("openrouter", NEW);
    expect(preferredCredential([only])).toBe(only);
  });

  it("yields nothing for an org with no keys", () => {
    expect(preferredCredential([])).toBeUndefined();
  });

  /**
   * The row itself, not a projection of it: the callers decrypt the
   * `credentials_encrypted` they selected alongside these two columns, so a
   * function that rebuilt `{ provider, createdAt }` would hand back a row with
   * no key in it.
   */
  it("returns the caller's own row, extra columns and all", () => {
    const picked = preferredCredential([
      { provider: "google" as const, createdAt: new Date(NEW), secret: "cipher-a" },
      { provider: "openrouter" as const, createdAt: new Date(OLD), secret: "cipher-b" },
    ]);
    expect(picked?.secret).toBe("cipher-b");
  });

  it("leaves the caller's array in the order it was given", () => {
    const newer = row("google", NEW);
    const older = row("openrouter", OLD);
    const rows = [newer, older];
    preferredCredential(rows);
    expect(rows).toEqual([newer, older]);
  });

  it("agrees with sorting the whole list by the comparator", () => {
    const rows = [row("google", NEW), row("openrouter", OLD)];
    expect(preferredCredential(rows)).toBe([...rows].sort(compareCredentialOrder)[0]);
  });
});
