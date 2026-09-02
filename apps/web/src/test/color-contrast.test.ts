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
 * These numbers are not decoration. The palette they replaced put a primary
 * button's label at 3.10:1, meta text at 2.43:1, and every error alert in the
 * dark theme at 2.99:1, and nothing in the suite noticed for as long as it
 * shipped.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

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

const CSS = readFileSync(globalsCssPath(), "utf8");

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

/** The three grounds any text can land on. */
const GROUNDS = ["--color-panel", "--color-bg-sunken", "--color-bg"] as const;

function onEveryGround(what: string, fg: string, min = AA_TEXT): Pair[] {
  return GROUNDS.map((bg) => ({ what: `${what} on ${bg.replace("--color-", "")}`, fg, bg, min }));
}

const PAIRS: Pair[] = [
  ...onEveryGround("body copy", "--color-fg"),
  ...onEveryGround("labels, empty-state title, inactive segment", "--color-fg-secondary"),
  ...onEveryGround("13px row meta, 12px counters, placeholders", "--color-fg-tertiary"),
  ...onEveryGround("text still verbatim AI under the provenance lens", "--color-fg-dim"),
  ...onEveryGround("links (`text-accent`)", "--color-accent"),
  ...onEveryGround("a link being hovered", "--color-accent-hover"),
  ...onEveryGround("the Reject button, error alerts, destructive menu items", "--color-danger"),

  // Text on a fill rather than on a ground.
  {
    what: "the primary button's label",
    fg: "--color-accent-fg",
    bg: "--color-accent",
    min: AA_TEXT,
  },
  {
    what: "the primary button's label, hovered",
    fg: "--color-accent-fg",
    bg: "--color-accent-hover",
    min: AA_TEXT,
  },
  {
    what: "the brand tile and the active nav pill",
    fg: "--color-accent-soft-fg",
    bg: "--color-accent-soft",
    min: AA_TEXT,
  },

  // The five statuses, 12px semibold — the only status colours that exist.
  ...(["draft", "review", "scheduled", "published", "failed"] as const).map((status) => ({
    what: `the ${status} status chip`,
    fg: `--status-${status}-fg`,
    bg: `--status-${status}-bg`,
    min: AA_TEXT,
  })),

  // Non-text (§1.4.11).
  ...GROUNDS.map((bg) => ({
    what: `the focus ring on ${bg.replace("--color-", "")}`,
    fg: "--color-accent",
    bg,
    min: AA_NON_TEXT,
  })),
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
    "Quieter still than --color-border: the rule between list rows and the " +
    "skeleton's shimmer bars. Nothing is identified by it.",
  "--color-overlay":
    "A translucent scrim over the whole page. It carries no text and outlines " +
    "nothing; its job is to dim, and a ratio against it is undefined anyway " +
    "since it composites over whatever it covers.",
  "--color-bg": "A ground, checked as the `bg` side of every text pair above.",
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
  it("gives every colour token in :root a verdict — a pair or a written exemption", () => {
    const checked = new Set(PAIRS.flatMap((pair) => [pair.fg, pair.bg]));
    const undecided = [...light.keys()]
      .filter((token) => token.startsWith("--color-") || token.startsWith("--status-"))
      .filter((token) => !checked.has(token) && !(token in EXEMPT));

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
