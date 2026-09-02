/**
 * The scanner behind the contrast ratchet, tested on source it is given rather
 * than on the app.
 *
 * `color-contrast.test.ts` can only prove that the reading finds what the app
 * happens to contain today; it cannot prove what the reading does with a class
 * list the app does not have yet — an off-palette colour, a fill with no words
 * of its own, a foreground written into a template literal. Those are the
 * cases the ratchet exists to catch tomorrow, so they get source of their own.
 *
 * The fixture is written to a temp directory rather than committed: a `.tsx`
 * file full of deliberately wrong colours, sitting in `src/`, is exactly the
 * kind of thing that gets copied.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type Painted, readPaintedPairs } from "./painted-pairs";

/** The palette the fixtures are read against — the names globals.css declares. */
const TOKENS = new Set([
  "--color-bg",
  "--color-bg-sunken",
  "--color-panel",
  "--color-fg",
  "--color-fg-tertiary",
  "--color-accent",
  "--color-accent-fg",
  "--color-accent-hover",
  "--color-accent-soft",
  "--color-accent-soft-fg",
  "--color-border-soft",
  "--color-danger",
]);

let root: string | undefined;

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** Writes `files` into a throwaway tree and reads it. */
function scan(files: Record<string, string>): Painted {
  root = mkdtempSync(join(tmpdir(), "painted-pairs-"));
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  return readPaintedPairs(root, TOKENS);
}

function names(painted: Painted): string[] {
  return painted.pairs.map((pair) => `${pair.fg} on ${pair.bg}`);
}

describe("reading a class list", () => {
  it("pairs a foreground with the fill written beside it", () => {
    const painted = scan({ "a.tsx": 'const c = "rounded bg-accent text-accent-fg";' });

    expect(names(painted)).toEqual(["--color-accent-fg on --color-accent"]);
  });

  it("requires all three grounds of a foreground that names no fill", () => {
    // Nothing in the class list says where this lands, so anywhere is where it
    // can land — which is the whole of the fix: a token repainted onto a new
    // ground is checked against that ground without anyone remembering to say
    // so.
    const painted = scan({ "a.tsx": 'const c = "text-sm text-danger";' });

    expect(names(painted).sort()).toEqual([
      "--color-danger on --color-bg",
      "--color-danger on --color-bg-sunken",
      "--color-danger on --color-panel",
    ]);
  });

  it("reads a token referenced through an arbitrary value", () => {
    // How the `--status-*` colours are written: they are not registered in
    // `@theme`, so they have no utility of their own.
    const painted = scan({
      "a.tsx": 'const c = "bg-[var(--status-review-bg)] text-[var(--status-review-fg)]";',
    });

    expect(names(painted)).toEqual(["--status-review-fg on --status-review-bg"]);
  });

  it("resolves each variant state on its own, last one winning", () => {
    // The active nav pill: accent text on the bare page below 640px, and at
    // 640px a soft fill with its own foreground over the top. Reading the
    // string flat would demand accent-on-accent-soft, a pair the browser never
    // paints.
    const painted = scan({
      "a.tsx": 'const c = "text-accent sm:bg-accent-soft sm:text-accent-soft-fg";',
    });

    expect(names(painted).sort()).toEqual([
      "--color-accent on --color-bg",
      "--color-accent on --color-bg-sunken",
      "--color-accent on --color-panel",
      "--color-accent-soft-fg on --color-accent-soft",
    ]);
  });

  it("resolves a compound variant against the state it belongs to", () => {
    const painted = scan({
      "a.tsx": 'const c = "text-fg-tertiary hover:text-fg sm:hover:bg-bg-sunken";',
    });

    expect(names(painted)).toContain("--color-fg on --color-bg-sunken");
  });

  it("reads the chunks of a template literal", () => {
    // Half this app's class lists are templates with a shared transition
    // constant interpolated into the middle of them.
    const painted = scan({
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture IS a template literal — written as source text for the scanner to parse, not as one to evaluate here.
      "a.tsx": "const c = `p-1 text-fg-tertiary ${TRANSITION} hover:bg-bg-sunken hover:text-fg`;",
    });

    expect(names(painted)).toContain("--color-fg on --color-bg-sunken");
  });

  it("ignores the `text-*` utilities that are not colours", () => {
    const painted = scan({
      "a.tsx": 'const c = "text-sm text-center text-[13px] text-balance bg-clip-text";',
    });

    expect(painted.pairs).toEqual([]);
  });
});

describe("what the reading refuses to let through", () => {
  it("reports a colour that is not one of ours", () => {
    const painted = scan({ "a.tsx": 'const c = "bg-panel text-red-500";' });

    expect(painted.offPalette).toEqual([{ utility: "text-red-500", where: "a.tsx:1" }]);
    expect(painted.pairs).toEqual([]);
  });

  it("records a fill that carries no foreground of its own", () => {
    // Words could still be inherited onto it from an ancestor, which is the
    // one thing reading class lists cannot see — so it is surfaced for a human
    // verdict instead of being assumed wordless.
    const painted = scan({ "a.tsx": 'const c = "h-1.5 w-1.5 rounded-full bg-danger";' });

    expect(painted.bareFills).toEqual([{ token: "--color-danger", where: "a.tsx:1" }]);
  });

  it("does not call a ground a bare fill", () => {
    const painted = scan({ "a.tsx": 'const c = "min-h-screen bg-bg-sunken";' });

    expect(painted.bareFills).toEqual([]);
  });
});

describe("what counts as source", () => {
  it("reads no class name out of a comment or out of JSX text", () => {
    // The reason this uses a parser. A regex over the raw file matches the
    // prose between two attributes as if it were a string literal, and this
    // repo's components are documented in paragraphs that name class after
    // class.
    const painted = scan({
      "a.tsx": [
        "// Never write text-red-500 here; use bg-accent text-white instead.",
        "/* bg-danger text-fg */",
        "export const A = () => (",
        '  <p className="text-fg-tertiary">bg-danger text-red-500 is not a class</p>',
        ");",
      ].join("\n"),
    });

    expect(painted.offPalette).toEqual([]);
    expect(names(painted).sort()).toEqual([
      "--color-fg-tertiary on --color-bg",
      "--color-fg-tertiary on --color-bg-sunken",
      "--color-fg-tertiary on --color-panel",
    ]);
  });

  it("skips the tests and the test tree — they describe the app, they are not it", () => {
    const painted = scan({
      "a.test.tsx": 'const c = "bg-panel text-red-500";',
      "test/render.tsx": 'const c = "bg-panel text-red-500";',
    });

    expect(painted.offPalette).toEqual([]);
    expect(painted.classListCount).toBe(0);
  });

  it("applies the one rule globals.css writes over a class list", () => {
    // `.bg-accent.text-white { color: var(--color-accent-fg) }` — the landing
    // page mirrors the primary button by hand, and a literal white label is
    // wrong in the dark theme. Read flat this would be white-on-accent, a pair
    // the browser never paints and the dark theme would fail.
    const painted = scan({
      "a.tsx": 'const c = "bg-accent text-white hover:bg-accent-hover";',
    });

    expect(painted.offPalette).toEqual([]);
    expect(names(painted).sort()).toEqual([
      "--color-accent-fg on --color-accent",
      "--color-accent-fg on --color-accent-hover",
    ]);
  });

  it("still calls a literal white a finding anywhere else", () => {
    const painted = scan({ "a.tsx": 'const c = "bg-panel text-white";' });

    expect(painted.offPalette).toEqual([{ utility: "text-white", where: "a.tsx:1" }]);
  });
});
