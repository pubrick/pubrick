/**
 * What the app actually paints on what — read off the components, not off a
 * list somebody remembered to update.
 *
 * `color-contrast.test.ts` used to enumerate its pairs by hand and call a
 * token "decided" as soon as it appeared in one, either side. That is a hole
 * with a very specific shape: a token that later gains a SECOND ground keeps
 * the verdict its first ground earned, silently. Two were through it — the
 * review status foreground, enumerated only against its own chip background
 * while two screens had begun printing it as a sentence on the page and on a
 * card, and `--color-fg` on `--color-border-soft`, which is the selected
 * segment of every pill switcher at 14px semibold and had no pair at all.
 * Both happened to clear AA, which is the worse outcome: nothing was wrong on
 * screen, and the thing meant to notice next time was blind.
 *
 * So the pairs are derived from the class lists instead. Every string literal
 * in the app's own source is read as a candidate Tailwind class list; a
 * foreground in it is paired with the fill declared beside it, and a
 * foreground with no fill of its own is required to clear AA on ALL THREE
 * grounds, because with nothing said about where it lands, anywhere is where
 * it can land. Repainting a token onto a new ground therefore adds the pair by
 * itself, in the same commit as the paint.
 *
 * What this deliberately does NOT model:
 *
 *  - **Where an element sits in the tree.** It does not need to: the
 *    fill-less case already assumes the worst of the three grounds.
 *  - **Text that inherits a colour onto a foreign fill** — a `bg-accent` box
 *    with no `text-*` of its own, wrapping words coloured by an ancestor. No
 *    such element exists today (every fill either carries its own foreground
 *    or carries no text: the toast dots, the progress bar, the skeleton bars,
 *    the modal scrim), and `everyFillIsAccountedFor` below fails if one
 *    appears.
 *  - **Tailwind's exact cascade order** between two utilities that could both
 *    win in one context. Ties go to source order, which is Tailwind's rule for
 *    equal specificity, and "more variants wins" stands in for its variant
 *    ordering. Both are approximations; both err towards checking a pair that
 *    might not exist rather than skipping one that does.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
// The monorepo's own compiler, already a root devDependency and already how
// `pnpm typecheck` resolves. A regex over the raw text is not an option here:
// JSX text between two attributes looks exactly like a quoted string, and half
// of this repo's class lists live next to prose that mentions class names.
import ts from "typescript";

export type PaintedPair = {
  /** `--color-*` / `--status-*` token painted as text. */
  fg: string;
  /** The token it is painted on. */
  bg: string;
  /** `file:line` of the class list it was read from — so a failure is findable. */
  where: string;
};

/** The three surfaces any text in this app can land on. */
export const GROUNDS = ["--color-bg", "--color-bg-sunken", "--color-panel"] as const;

/**
 * Colour words Tailwind ships that are not ours. `transparent`/`current` are
 * legitimate (a fill that is not a fill, the icon stroke that follows text);
 * everything else is a colour chosen outside the palette, which is the one
 * thing globals.css says must never happen.
 */
const NEUTRAL_LITERALS = new Set(["transparent", "current", "inherit", "none", "auto"]);
const TAILWIND_PALETTE =
  /^(?:white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?$/;

/**
 * The one place a class list does not mean what it says.
 *
 * globals.css carries an un-layered `.bg-accent.text-white { color:
 * var(--color-accent-fg) }`, because the landing page mirrors the primary
 * button's classes by hand instead of calling `buttonClasses()`, and a literal
 * white label is wrong in the dark theme. Reading that pair as white-on-accent
 * would fail the dark theme for a colour the browser never paints. Applying
 * the rule here instead keeps the pair honest AND keeps `text-white` a finding
 * everywhere else — the day that page calls `buttonClasses()`, both this and
 * the CSS rule go.
 */
function resolveCssOverrides(classNames: string[]): string[] {
  if (!classNames.includes("text-white") || !classNames.includes("bg-accent")) return classNames;
  return classNames.map((name) => (name === "text-white" ? "text-accent-fg" : name));
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      // The test tree describes the app; it does not paint it.
      if (entry !== "test") walkFiles(path, out);
      continue;
    }
    if (![".ts", ".tsx"].includes(extname(path))) continue;
    if (/\.test\.tsx?$/.test(path)) continue;
    out.push(path);
  }
  return out;
}

/** Every string literal in the file, with the line it starts on. */
function stringLiterals(path: string): Array<{ text: string; line: number }> {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const found: Array<{ text: string; line: number }> = [];
  const at = (node: ts.Node) =>
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

  function visit(node: ts.Node) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      found.push({ text: node.text, line: at(node) });
    } else if (ts.isTemplateExpression(node)) {
      // Each literal chunk on its own: a class cannot straddle an
      // interpolation, and every interpolation in this app is a whole class
      // list of its own (which is visited in its own right).
      const line = at(node);
      found.push({ text: node.head.text, line });
      for (const span of node.templateSpans) found.push({ text: span.literal.text, line });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

/** Splits `sm:hover:bg-x` into variants + utility, ignoring `:` inside `[]`. */
function splitVariants(className: string): { variants: string[]; utility: string } {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of className) {
    if (char === "[" || char === "(") depth += 1;
    else if (char === "]" || char === ")") depth -= 1;
    if (char === ":" && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  const utility = parts.pop() ?? "";
  return { variants: parts, utility };
}

type Declaration = { kind: "fg" | "bg"; token: string | null; variants: string[]; index: number };

/**
 * `text-fg` → `--color-fg`; `bg-[var(--status-review-bg)]` → that token;
 * `bg-bg/95` → `--color-bg`; `text-sm`, `text-center`, `text-[13px]` → not a
 * colour at all. A colour word Tailwind ships rather than one of ours returns
 * `null`, which is a finding, not a skip.
 */
function readDeclaration(
  utility: string,
  declaredTokens: ReadonlySet<string>,
): { kind: "fg" | "bg"; token: string | null } | null {
  const [, prefix = "", rawValue = ""] = /^(text|bg)-(.+)$/.exec(utility) ?? [];
  if (prefix === "") return null;
  const kind = prefix === "text" ? "fg" : "bg";
  const value = rawValue.replace(/\/\d+$/, "");
  const [, arbitrary] = /^\[var\((--[\w-]+)\)\]$/.exec(value) ?? [];
  if (arbitrary !== undefined) return { kind, token: arbitrary };
  if (value.startsWith("[")) return null; // an arbitrary length/other value
  if (NEUTRAL_LITERALS.has(value)) return null;
  if (declaredTokens.has(`--color-${value}`)) return { kind, token: `--color-${value}` };
  if (TAILWIND_PALETTE.test(value)) return { kind, token: null };
  return null; // `text-sm`, `text-center`, `bg-clip-text`, …
}

/**
 * Every subset of the variants present, so each state is resolved on its own —
 * the bare element, `sm:`, `hover:`, `sm:` and `hover:` together.
 *
 * Throws rather than truncating past eight: silently checking some of a class
 * list's states and not others is the failure this whole file exists to stop.
 * Nothing in the app comes near it (three is the most today).
 */
function contexts(declarations: Declaration[], where: string): string[][] {
  const atoms = [...new Set(declarations.flatMap((d) => d.variants))];
  if (atoms.length > 8)
    throw new Error(`${where}: ${atoms.length} variants is too many to resolve`);
  let all: string[][] = [[]];
  for (const atom of atoms) all = [...all, ...all.map((set) => [...set, atom])];
  return all;
}

function winner(
  declarations: Declaration[],
  kind: "fg" | "bg",
  context: string[],
): Declaration | undefined {
  return declarations
    .filter((d) => d.kind === kind && d.variants.every((v) => context.includes(v)))
    .sort((a, b) => a.variants.length - b.variants.length || a.index - b.index)
    .pop();
}

export type Painted = {
  pairs: PaintedPair[];
  /** Fills that carry no foreground of their own, so nothing pairs with them. */
  bareFills: Array<{ token: string; where: string }>;
  /** Colours chosen outside the palette. */
  offPalette: Array<{ utility: string; where: string }>;
  /** How many class lists were read — a scanner that matches nothing is a lie. */
  classListCount: number;
};

/**
 * Reads every class list under `root` and returns what it paints.
 *
 * `declaredTokens` is the set of `--color-*` names globals.css declares, so
 * `text-fg` is recognised as a colour and `text-sm` is not — no second list of
 * "which utilities are colours" to keep in step with the palette.
 */
export function readPaintedPairs(root: string, declaredTokens: ReadonlySet<string>): Painted {
  const pairs = new Map<string, PaintedPair>();
  const bareFills = new Map<string, { token: string; where: string }>();
  const offPalette: Array<{ utility: string; where: string }> = [];
  let classListCount = 0;

  for (const path of walkFiles(root)) {
    const relative = path.slice(root.length + 1);
    for (const { text, line } of stringLiterals(path)) {
      const where = `${relative}:${line}`;
      const declarations: Declaration[] = [];
      let index = 0;
      for (const className of resolveCssOverrides(text.split(/\s+/).filter(Boolean))) {
        const { variants, utility } = splitVariants(className);
        const declaration = readDeclaration(utility, declaredTokens);
        if (declaration === null) continue;
        if (declaration.token === null) {
          offPalette.push({ utility: className, where });
          continue;
        }
        declarations.push({ ...declaration, token: declaration.token, variants, index: index++ });
      }
      if (declarations.length === 0) continue;
      classListCount += 1;

      for (const context of contexts(declarations, where)) {
        const fg = winner(declarations, "fg", context);
        const bg = winner(declarations, "bg", context);
        if (fg?.token == null) {
          // A fill with no text of its own in this context. Harmless if it
          // carries no text at all — which is a judgement, made in the test.
          if (bg?.token != null && !(GROUNDS as readonly string[]).includes(bg.token)) {
            bareFills.set(bg.token, { token: bg.token, where });
          }
          continue;
        }
        const grounds = bg?.token == null ? GROUNDS : [bg.token];
        for (const ground of grounds) {
          pairs.set(`${fg.token} on ${ground}`, { fg: fg.token, bg: ground, where });
        }
      }
    }
  }

  return {
    pairs: [...pairs.values()].sort((a, b) => `${a.fg}${a.bg}`.localeCompare(`${b.fg}${b.bg}`)),
    bareFills: [...bareFills.values()],
    offPalette,
    classListCount,
  };
}
