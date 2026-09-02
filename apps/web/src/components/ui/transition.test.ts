import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TRANSITION_COLORS } from "./transition";

const UI_DIR = join(import.meta.dirname, ".");
const COMPONENTS_DIR = join(import.meta.dirname, "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (entry) => entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.includes(".test."),
    )
    .map((entry) => join(dir, entry.name));
}

describe("TRANSITION_COLORS", () => {
  it("does not transition outline-color", () => {
    // The app's whole focus treatment is `outline: 2px solid …` (globals.css).
    // Tailwind's own `transition-colors` includes `outline-color`, so using it
    // animates the focus ring's colour: the ring fades up from the element's
    // currentColor instead of appearing where you now are, and it lags a fast
    // Tab-Tab-Tab. Naming the three properties that DO change on hover is what
    // leaves the ring alone.
    expect(TRANSITION_COLORS).not.toContain("outline");
    expect(TRANSITION_COLORS).toBe("transition-[color,background-color,border-color]");
  });

  it("is what every component in components/ actually uses — nothing reaches for the bare utility", () => {
    // A ratchet, not a style rule: one `transition-colors` slipping back into a
    // component silently restores the animated ring on that control only, which
    // is exactly the kind of thing nobody notices in review.
    const offenders = [...sourceFiles(UI_DIR), ...sourceFiles(COMPONENTS_DIR)]
      .filter((file) => /\btransition-colors\b/.test(readFileSync(file, "utf8")))
      // transition.ts documents the problem, so it names the utility on purpose.
      .filter((file) => !file.endsWith("transition.ts"));

    expect(offenders).toEqual([]);
  });
});
