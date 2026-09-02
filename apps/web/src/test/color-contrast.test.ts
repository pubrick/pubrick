/**
 * The palette's WCAG contract, computed from the palette itself.
 *
 * `app/globals.css` is the only place a colour is chosen, so this is the only
 * place a colour has to answer for itself. The test reads that file, resolves
 * every `var()` chain per theme, and asserts a ratio for each pair the app
 * actually paints — text on its ground, a label on its fill, a chip's word on
 * its pill, a control's boundary against both sides of itself.
 *
 * Three properties, in order of what they catch:
 *
 *  1. **Ratios.** AA: 4.5:1 for text (the app has no large text in any of
 *     these roles — the biggest is a 15px semibold row title, and the primary
 *     button's label is 14px semibold, both "normal" by WCAG's 18.66px-bold /
 *     24px rule), 3:1 for the non-text pairs (§1.4.11): the focus ring and a
 *     form control's border.
 *  2. **Coverage.** Every `--color-*` / `--status-*` token declared in `:root`
 *     appears in a pair or in `EXEMPT` with a written reason. A new token
 *     cannot be added without a verdict on how it is read.
 *  3. **Theme parity.** The dark theme is written twice (media query and
 *     `[data-theme]` attribute) and mirrored a third time by `.gallery-light`;
 *     all three are compared, so a token moved in one copy cannot be forgotten
 *     in the others — which would show as the light gallery going dark, or as
 *     `prefers-color-scheme` and the theme toggle disagreeing.
 *
 * Where the pairs come from is the fourth property, and the one this file got
 * wrong first. They were a hand-written list, and coverage counted a token
 * decided the moment it appeared in ANY pair, foreground or background — so a
 * token that later gained a second ground kept the verdict its first ground
 * had earned, and nothing said a word. `--status-review-fg` was enumerated
 * only against its own chip while two screens were printing it as a sentence
 * on the page and on a card; `--color-fg` on `--color-border-soft` — the
 * selected segment of every pill switcher, 14px semibold — had no pair at all,
 * under an exemption whose reason ("nothing is identified by it") had stopped
 * being true. Both cleared AA anyway, which is the worse way to find out.
 *
 * Every pair a component can express is therefore READ OFF the components now,
 * by `painted-pairs.ts` — a repaint brings its own pair with it, in its own
 * commit. `DECLARED` below is only what no class list can say: the rules
 * globals.css writes itself.
 *
 * These numbers are not decoration. The palette they replaced put a primary
 * button's label at 3.10:1, meta text at 2.43:1, and every error alert in the
 * dark theme at 2.99:1, and nothing in the suite noticed for as long as it
 * shipped.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GROUNDS, readPaintedPairs } from "./painted-pairs";

/**
 * Found by walking up from the working directory rather than from
 * `import.meta.url`: vite-node hands this module a non-`file:` URL, so
 * `fileURLToPath` throws. Vitest runs with `apps/web` as its root, so the
 * first candidate hits; the walk is there so a single-file invocation from
 * the repo root finds it too, instead of failing with an unhelpful ENOENT.
 */
function globalsCssPath(): string {
  let directory = process.cwd();
  for (;;) {
    const candidate = resolve(directory, "apps/web/src/app/globals.css");
    const here = resolve(directory, "src/app/globals.css");
    if (existsSync(here)) return here;
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`globals.css not found from ${process.cwd()}`);
    directory = parent;
  }
}

const CSS_PATH = globalsCssPath();
const CSS = readFileSync(CSS_PATH, "utf8");
/** `…/src/app/globals.css` → `…/src`: the tree whose class lists are read. */
const SOURCE_ROOT = dirname(dirname(CSS_PATH));

// — parsing ————————————————————————————————————————————————————————————

/**
 * Innermost declaration blocks only (`[^{}]` on both sides), which is what
 * lets the one nested block — `:root:not([data-theme="light"])` inside the
 * `prefers-color-scheme` media query — fall out of the same pass as the
 * top-level ones. Comments are stripped first: they contain braces-free prose
 * today, but a `{` in a comment would otherwise silently split a block.
 */
function customProperties(selector: string): Map<string, string> {
  const source = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = source.matchAll(/([^{}]+)\{([^{}]*)\}/g);
  for (const [, rawSelector = "", body = ""] of blocks) {
    // `[^{}]+` swallows everything since the previous block's `}`, so the
    // capture can carry a trailing statement (`@import "tailwindcss";`) or an
    // enclosing at-rule's prelude ahead of the selector itself.
    const cleaned = (rawSelector.split(";").pop() ?? "").trim().replace(/\s+/g, " ");
    if (cleaned !== selector) continue;
    const declarations = new Map<string, string>();
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      if (name !== undefined && value !== undefined) declarations.set(name, value.trim());
    }
    return declarations;
  }
  throw new Error(`globals.css has no block for selector \`${selector}\``);
}

const LIGHT_SELECTOR = ":root";
const DARK_ATTR_SELECTOR = ':root[data-theme="dark"], .gallery-dark';
const DARK_MEDIA_SELECTOR = ':root:not([data-theme="light"])';
const GALLERY_LIGHT_SELECTOR = ".gallery-light";

const light = customProperties(LIGHT_SELECTOR);
const darkAttribute = customProperties(DARK_ATTR_SELECTOR);
const darkMedia = customProperties(DARK_MEDIA_SELECTOR);
const galleryLight = customProperties(GALLERY_LIGHT_SELECTOR);

/**
 * `var()` chains resolve against the theme first and the light `:root` second
 * — exactly how the cascade does it, since the dark blocks redefine only
 * semantic tokens and inherit every primitive from `:root`.
 */
function resolveToken(token: string, theme: Map<string, string>): string {
  const seen = new Set<string>();
  let value = theme.get(token) ?? light.get(token);
  while (value !== undefined) {
    const [, next] = /^var\((--[\w-]+)\)$/.exec(value.trim()) ?? [];
    if (next === undefined) return value.trim();
    if (seen.has(next)) throw new Error(`\`${token}\` resolves in a cycle`);
    seen.add(next);
    value = theme.get(next) ?? light.get(next);
  }
  throw new Error(`\`${token}\` is not defined in this theme`);
}

// — contrast ———————————————————————————————————————————————————————————

/** WCAG 2.x relative luminance (sRGB), the definition the ratio is built on. */
function luminance(hex: string): number {
  const [, digits] = /^#([0-9a-f]{6})$/i.exec(hex) ?? [];
  if (digits === undefined) throw new Error(`\`${hex}\` is not a six-digit hex colour`);
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const channel = Number.parseInt(digits.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

// — the pairs ——————————————————————————————————————————————————————————

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3;

type Pair = {
  /** What the reader is looking at when this pair is on screen. */
  what: string;
  fg: string;
  bg: string;
  min: number;
};

function onEveryGround(what: string, fg: string, min = AA_TEXT): Pair[] {
  return GROUNDS.map((bg) => ({ what: `${what} on ${bg.replace("--color-", "")}`, fg, bg, min }));
}

/**
 * The pairs no component can declare, because globals.css paints them itself.
 *
 * Everything else — every `text-*` beside a `bg-*`, every foreground with no
 * fill of its own — is derived from the source below, and must NOT be
 * duplicated here: a hand-written copy is how the list stopped matching the
 * app the first time.
 */
const DECLARED: Pair[] = [
  // `@layer base { a:hover { color: var(--color-accent-hover) } }` — a rule on
  // the element, not a utility class, so nothing in the markup names it.
  ...onEveryGround("a link being hovered", "--color-accent-hover"),

  // Non-text (§1.4.11). `:focus-visible { outline: 2px solid var(--color-accent) }`,
  // again a base-layer rule rather than a class.
  ...GROUNDS.map((bg) => ({
    what: `the focus ring on ${bg.replace("--color-", "")}`,
    fg: "--color-accent",
    bg,
    min: AA_NON_TEXT,
  })),
  // A control's border is `border-border-strong` in the markup, but what it
  // owes 3:1 against is BOTH sides of itself — its own fill and the ground the
  // control is standing on — and only the first of those is ever written in
  // the same class list.
  {
    what: "a text field's border against its own fill",
    fg: "--color-border-strong",
    bg: "--color-panel",
    min: AA_NON_TEXT,
  },
  {
    what: "a text field's border against the page around it",
    fg: "--color-border-strong",
    bg: "--color-bg-sunken",
    min: AA_NON_TEXT,
  },
];

/**
 * ...and everything the components themselves say. See `painted-pairs.ts` for
 * how a class list becomes a pair, and for what that reading does and does not
 * model.
 *
 * `light.keys()` is what teaches the reader which utilities are colours:
 * `text-fg` is one because `--color-fg` is declared, `text-sm` is not because
 * `--color-sm` isn't. There is no second list of colour names to drift.
 */
const PAINTED = readPaintedPairs(SOURCE_ROOT, new Set(light.keys()));

const PAIRS: Pair[] = [
  ...DECLARED,
  ...PAINTED.pairs.map((pair) => ({
    what: `painted at ${pair.where}`,
    fg: pair.fg,
    bg: pair.bg,
    // Text, always: the app's only large text is the 30px page title, which
    // would be allowed 3:1, and holding it to 4.5 costs nothing and removes a
    // font-size model from this file.
    min: AA_TEXT,
  })),
];

/**
 * Fills that appear with no foreground beside them — so no pair names them,
 * and the reason has to be that nothing is READ on them. Each entry is that
 * judgement; a new one is a prompt to check whether the thing really is
 * wordless.
 */
const FILLS_WITHOUT_TEXT: Record<string, string> = {
  "--color-accent":
    "The toast's status dot and the Advanced section's unsaved dot: 6px " +
    "circles marked aria-hidden. Also the label-less fill of the primary " +
    "button, which does carry text — and is checked that way, from the " +
    "button's own class list.",
  "--color-danger": "The error toast's dot. Same 6px circle, same aria-hidden.",
  "--color-overlay":
    "The modal scrim. It carries no text and outlines nothing, and a ratio " +
    "against it is undefined anyway since it composites over what it covers.",
  "--color-border-soft":
    "The skeleton's shimmer bars — placeholders for text that has not " +
    "arrived, with none of their own. Where this fill DOES carry a word (the " +
    "selected segment of a pill switcher) the pair is derived from that class " +
    "list.",
};

/**
 * Tokens with no contrast requirement, each with the reason it has none.
 * Judged, not waived: the entry is the argument, and it is here so a later
 * reader can disagree with it in one place.
 */
const EXEMPT: Record<string, string> = {
  "--color-border":
    "The seam BETWEEN surfaces — card edge, modal rim, list rule. §1.4.11 " +
    "measures what is needed to identify a component; a card is identified by " +
    "its background and shadow, and the seam only says where it stops. Held " +
    "at ~1.2:1 on purpose: at 3:1 every card becomes a wireframe. The border " +
    "that IS load-bearing — a control's — is `--color-border-strong`, checked " +
    "above.",
  "--color-border-soft":
    "Quieter still than --color-border as a rule between list rows. NOT " +
    "quieter as a fill: since the pill switcher it is also the selected " +
    "segment's background, and `--color-fg` on it is checked as a derived " +
    "pair. This entry covers only the rule.",
  // `--color-bg` used to sit here, excused as "a ground". It is also the
  // letter in the user block's avatar — `bg-fg text-bg` — so it is read, and
  // the derived pair checks it both ways. Reading the components is what
  // noticed; the hand-written list had not.
  "--color-bg-sunken": "A ground, checked as the `bg` side of every text pair above.",
  "--color-panel": "A ground, checked as the `bg` side of every text pair above.",
  "--color-accent-soft": "A fill, checked as the `bg` side of the accent-soft pair above.",
};

const THEMES: Array<[string, Map<string, string>]> = [
  ["light", light],
  ["dark", darkAttribute],
];

describe.each(THEMES)("%s theme contrast", (_name, theme) => {
  it.each(PAIRS)("$what — $fg on $bg clears $min:1", ({ fg, bg, min }) => {
    const ratio = contrast(resolveToken(fg, theme), resolveToken(bg, theme));
    expect(ratio).toBeGreaterThanOrEqual(min);
  });
});

describe("the contract itself", () => {
  it("gives every colour token in :root a verdict", () => {
    // Three kinds of verdict, and no fourth: it is in a pair, it is exempt
    // with a reason, or it is a fill nothing is read on. Appearing in a pair
    // is no longer something a human grants — it is what the components say —
    // so "decided" now means decided against every ground it is painted on.
    const checked = new Set(PAIRS.flatMap((pair) => [pair.fg, pair.bg]));
    const undecided = [...light.keys()]
      .filter((token) => token.startsWith("--color-") || token.startsWith("--status-"))
      .filter(
        (token) => !checked.has(token) && !(token in EXEMPT) && !(token in FILLS_WITHOUT_TEXT),
      );

    expect(undecided).toEqual([]);
  });

  it("exempts no token that is ever painted as a foreground", () => {
    // Grounds and fills are the deliberate overlap: exempt in their own right
    // (nothing is read *against* a background) while carrying every pair above
    // as the `bg` side. A token that appears as an `fg` and is also exempt is
    // a contradiction — it is read, and it has been excused from being legible.
    const painted = new Set(PAIRS.map((pair) => pair.fg));
    const bothWays = Object.keys(EXEMPT).filter((token) => painted.has(token));

    expect(bothWays).toEqual([]);
  });

  it("keeps the decorative seam visible even though it owes no ratio", () => {
    for (const [, theme] of THEMES) {
      expect(
        contrast(resolveToken("--color-border", theme), resolveToken("--color-panel", theme)),
      ).toBeGreaterThan(1.1);
    }
  });
});

/**
 * The reading itself, which is now the part that can go quietly wrong.
 *
 * A scanner that stops matching — a class list built some new way, a parser
 * that throws and is caught somewhere — produces an empty pair list, and an
 * empty pair list passes every ratio there is. So the reading is asserted
 * before the ratios mean anything.
 */
describe("reading the app rather than a list of it", () => {
  it("reads the class lists it claims to read", () => {
    expect(PAINTED.classListCount).toBeGreaterThan(120);
    expect(PAINTED.pairs.length).toBeGreaterThan(25);
  });

  it("sees the two paints the hand-written list did not", () => {
    // The finding, pinned. The first was introduced by the delivery-outcome
    // work — "we don't know whether this went out, check the channel", printed
    // in the review colour on the queue (page ground) and on the item screen
    // (card ground) — thirty-six minutes before this file was first written.
    // The second is the selected segment of every pill switcher.
    const derived = PAINTED.pairs.map((pair) => `${pair.fg} on ${pair.bg}`);

    expect(derived).toContain("--status-review-fg on --color-panel");
    expect(derived).toContain("--status-review-fg on --color-bg");
    expect(derived).toContain("--status-review-fg on --color-bg-sunken");
    expect(derived).toContain("--color-fg on --color-border-soft");
  });

  it("still pairs a chip's word with its own pill", () => {
    // The same token's first ground, which it does not lose by gaining others.
    const derived = PAINTED.pairs.map((pair) => `${pair.fg} on ${pair.bg}`);

    expect(derived).toContain("--status-review-fg on --status-review-bg");
    expect(derived).toContain("--color-accent-fg on --color-accent");
  });

  it("uses no colour that is not one of ours", () => {
    // A `text-red-500` anywhere in the app is outside the palette, so outside
    // everything above — including the dark theme, which it would not follow.
    expect(PAINTED.offPalette).toEqual([]);
  });

  it("accounts for every fill that carries no foreground of its own", () => {
    // The one case deriving from class lists cannot see: a fill whose words
    // are coloured by an ancestor. Today every such fill is wordless, and each
    // says so in FILLS_WITHOUT_TEXT. A new one is a question to answer, not a
    // line to add.
    const unexplained = PAINTED.bareFills
      .filter((fill) => !(fill.token in FILLS_WITHOUT_TEXT))
      .map((fill) => `${fill.token} (${fill.where})`);

    expect(unexplained).toEqual([]);
  });

  it("keeps no reason for a fill that is no longer bare", () => {
    const stale = Object.keys(FILLS_WITHOUT_TEXT).filter(
      (token) => !PAINTED.bareFills.some((fill) => fill.token === token),
    );

    expect(stale).toEqual([]);
  });
});

describe("theme parity", () => {
  it("writes the same dark theme in the media query and under [data-theme]", () => {
    expect(Object.fromEntries(darkMedia)).toEqual(Object.fromEntries(darkAttribute));
  });

  it("restates in .gallery-light every token the dark theme moves", () => {
    // Without this the light half of /design inherits the dark values from the
    // real root whenever the OS is in dark mode.
    const moved = [...darkAttribute.keys()].filter((token) => token.startsWith("--"));
    const missing = moved.filter((token) => !galleryLight.has(token));

    expect(missing).toEqual([]);
  });

  it("gives .gallery-light the same values :root does", () => {
    for (const [token, value] of galleryLight) {
      expect(`${token}: ${value}`).toBe(`${token}: ${light.get(token)}`);
    }
  });
});
