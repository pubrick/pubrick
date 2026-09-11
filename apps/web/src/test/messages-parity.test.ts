import { REFINE_VERBS } from "@pubrick/shared";
import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import pt from "../../messages/pt.json";
import ru from "../../messages/ru.json";

/**
 * Page tests assert against the real `messages/en.json`, so a renamed or
 * removed *English* key breaks a test on purpose. Nothing covers the other
 * three: `es`, `ru` and `pt` are at parity today by luck, and adding a key to
 * `en` alone would ship as missing text in three languages with a completely
 * green suite — next-intl falls back to rendering the key path, which is what
 * the user then sees on screen.
 *
 * Comparison is on full dotted paths, not top-level namespaces: a locale that
 * has `Content` but is missing `Content.status.failed` inside it is exactly
 * the case a shallow check waves through.
 */
type Messages = { [key: string]: string | Messages };

function keyPaths(messages: Messages, prefix = ""): string[] {
  return Object.entries(messages).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "object" && value !== null ? keyPaths(value, path) : [path];
  });
}

const reference = keyPaths(en as Messages).sort();

describe.each([
  ["es", es],
  ["ru", ru],
  ["pt", pt],
])("messages/%s.json is at key parity with en.json", (_locale, messages) => {
  it("has exactly the same key paths — no missing translations, no orphans", () => {
    expect(keyPaths(messages as Messages).sort()).toEqual(reference);
  });
});

/**
 * KEY PARITY IS NOT ENOUGH once a message takes an argument.
 *
 * `t("unknownOutcome", { channel })` interpolates `{channel}` into the
 * sentence. A translation that drops the placeholder still has the key, still
 * renders, and still reads like a finished sentence — it simply stops naming
 * the thing the reader was told to go and check. For the unknown-delivery
 * advice that is the whole payload: the post may be live in a channel this
 * screen cannot link to, and the channel's name is the only address it has.
 *
 * Compared as a SET: an argument may legitimately appear a different number of
 * times, or in a different position, in another language.
 */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1] as string).sort();
}

function flatEntries(messages: Messages, prefix = ""): [string, string][] {
  return Object.entries(messages).flatMap(([key, value]): [string, string][] => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === "object" && value !== null
      ? flatEntries(value, path)
      : [[path, value as string]];
  });
}

const referenceArgs = new Map(
  flatEntries(en as Messages).map(([path, value]) => [path, placeholders(value)]),
);

describe.each([
  ["es", es],
  ["ru", ru],
  ["pt", pt],
])("messages/%s.json interpolates what en.json interpolates", (_locale, messages) => {
  it("carries the same arguments in every message that takes one", () => {
    const mismatched = flatEntries(messages as Messages)
      .map(([path, value]) => ({
        path,
        expected: referenceArgs.get(path) ?? [],
        actual: [...new Set(placeholders(value))].sort(),
      }))
      .filter(
        (row) => JSON.stringify([...new Set(row.expected)].sort()) !== JSON.stringify(row.actual),
      );
    expect(mismatched).toEqual([]);
  });
});

describe("the reference locale itself", () => {
  it("is non-empty, so parity cannot be satisfied by four empty files", () => {
    expect(reference.length).toBeGreaterThan(0);
  });
});

/**
 * A KEY THAT EXISTS BUT SAYS NOTHING passes every check above.
 *
 * next-intl renders an empty string as an empty string — no fallback, no key
 * path, no warning — so a message emptied by a bad merge or a half-finished
 * translation disappears from the screen while the element around it still
 * renders. The costly instances are the ones that carry a WARNING: the
 * unknown-delivery advice, and the thirteen `failure.*` codes behind
 * `runFailureMessage`, where the strip keeps its shape and simply stops saying
 * what went wrong. Every one of those was unguarded — a page test asserting
 * `getByText(en.Runs.failure.internal)` looks for the empty string and finds
 * the whole document.
 *
 * Checked in all four locales, not only the reference: an empty translation is
 * exactly as blank on screen as an empty English string.
 */
describe.each([
  ["en", en],
  ["es", es],
  ["ru", ru],
  ["pt", pt],
])("messages/%s.json actually says something", (_locale, messages) => {
  it("has no blank message anywhere", () => {
    const blank = flatEntries(messages as Messages)
      .filter(([, value]) => value.trim() === "")
      .map(([path]) => path);
    expect(blank).toEqual([]);
  });
});

/**
 * A CLOSED LIST IN `@pubrick/shared` NEEDS A LABEL PER MEMBER, in four
 * languages, and nothing in the web app would say so.
 *
 * `REFINE_VERBS` is the rule book's array — the proposal table's CHECK
 * constraint reads it, the model's role lines read it, and the item screen maps
 * over it to build the verb menu. Adding a fourth verb there is a one-line
 * change that compiles, passes typecheck (`t()` takes a template string), and
 * ships a menu item reading `Publish.refineVerb.sharper` to every reader:
 * next-intl's fallback for a missing key is the key path itself. Parity above
 * cannot see it either — three locales missing a key the reference also lacks
 * are at perfect parity.
 *
 * So the totality is asserted against the LIST rather than against English:
 * a fourth member fails here until four sentences exist for it.
 */
describe("Publish.refineVerb covers REFINE_VERBS", () => {
  it.each([
    ["en", en],
    ["es", es],
    ["ru", ru],
    ["pt", pt],
  ])("%s has exactly one label per verb, and no orphan", (_locale, messages) => {
    const labels = (messages as unknown as { Publish: { refineVerb: Record<string, string> } })
      .Publish.refineVerb;
    expect(Object.keys(labels).sort()).toEqual([...REFINE_VERBS].sort());
  });
});

/**
 * A PLURAL THAT IS A PLURAL IN ENGLISH ONLY passes every check above.
 *
 * `placeholders()` matches `/\{(\w+)\}/`, which does not match
 * `{count, plural, …}` — so all four locales report "no arguments" for a
 * pluralised message, and a translation that flattened it to one sentence, or
 * dropped a category, would sail through key parity, argument parity and the
 * blank check together. What the reader gets is a number glued to the wrong
 * noun ("2 канал"), or — for a dropped category — `intl-messageformat`
 * falling back to `other` in cases the language does not spell that way.
 *
 * Two things are asserted, both against the LOCALE's own requirements rather
 * than against English's shape:
 *
 * 1. the same message takes the same PLURAL arguments in every locale, so a
 *    plural cannot be quietly dropped in translation; and
 * 2. every plural argument spells the categories that locale needs. Russian
 *    needs four (`one` 1, 21; `few` 2-4; `many` 5-20, 0; `other` fractions);
 *    English, Spanish and Portuguese need `one` and `other`. This is the
 *    minimum the catalogue's own sentences already distinguish, not a claim
 *    to have transcribed CLDR — a locale that later needs another category
 *    gets a line here.
 */
const REQUIRED_PLURAL_CATEGORIES: Record<string, string[]> = {
  en: ["one", "other"],
  es: ["one", "other"],
  pt: ["one", "other"],
  ru: ["few", "many", "one", "other"],
};

/**
 * Every `{name, plural, …}` argument in a message, with the categories it
 * spells — brace-counted rather than regexed, because a plural's options
 * contain braces of their own (`#`-bearing sub-messages, and nested plurals in
 * `unrecordedCalls`).
 */
function pluralArgs(value: string): { name: string; categories: Set<string> }[] {
  const found: { name: string; categories: Set<string> }[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== "{") continue;
    const head = /^\{\s*(\w+)\s*,\s*plural\s*,/.exec(value.slice(i));
    if (!head) continue;
    const body = balanced(value, i);
    if (body === null) continue;
    const options = value.slice(i + (head[0] as string).length, body);
    // A LIST, not a map keyed by name: `Runs.unrecordedCalls` pluralises
    // `count` TWICE in one sentence, and keying by name would let a second
    // block with missing categories hide behind a complete first one.
    found.push({ name: head[1] as string, categories: categories(options) });
    // The options are re-scanned by the outer loop, so a nested plural inside
    // one of them is found on its own.
  }
  return found;
}

/** Index of the `}` closing the `{` at `open`, or null if it is unbalanced. */
function balanced(value: string, open: number): number | null {
  let depth = 0;
  for (let i = open; i < value.length; i++) {
    if (value[i] === "{") depth++;
    else if (value[i] === "}" && --depth === 0) return i;
  }
  return null;
}

/** The category keywords at the top level of a plural's option list. */
function categories(options: string): Set<string> {
  const names = new Set<string>();
  let i = 0;
  while (i < options.length) {
    while (i < options.length && /\s/.test(options[i] as string)) i++;
    const start = i;
    while (i < options.length && options[i] !== "{") i++;
    if (i >= options.length) break;
    // `offset:N` rides in front of the first category rather than on a block
    // of its own, so the keyword is the LAST word before the brace.
    const words = options
      .slice(start, i)
      .split(/\s+/)
      .filter((word) => word !== "" && !word.startsWith("offset:"));
    const close = balanced(options, i);
    if (close === null) break;
    const keyword = words[words.length - 1];
    if (keyword !== undefined) names.add(keyword);
    i = close + 1;
  }
  return names;
}

const referencePlurals = new Map(
  flatEntries(en as Messages).map(([path, value]) => [
    path,
    pluralArgs(value)
      .map((arg) => arg.name)
      .sort(),
  ]),
);

describe.each([
  ["en", en],
  ["es", es],
  ["ru", ru],
  ["pt", pt],
])("messages/%s.json pluralises what en.json pluralises", (locale, messages) => {
  it("keeps every plural a plural, with the categories this language needs", () => {
    const required = REQUIRED_PLURAL_CATEGORIES[locale] as string[];
    const wrong = flatEntries(messages as Messages)
      .map(([path, value]) => {
        const args = pluralArgs(value);
        return {
          path,
          expectedArgs: referencePlurals.get(path) ?? [],
          actualArgs: args.map((arg) => arg.name).sort(),
          missingCategories: args
            .flatMap((arg) =>
              required.filter((c) => !arg.categories.has(c)).map((c) => `${arg.name}: ${c}`),
            )
            .sort(),
        };
      })
      .filter(
        (row) =>
          JSON.stringify(row.expectedArgs) !== JSON.stringify(row.actualArgs) ||
          row.missingCategories.length > 0,
      );
    expect(wrong).toEqual([]);
  });
});

describe("the plural ratchet can see a plural at all", () => {
  it("finds the arguments and categories of a nested, offset-bearing plural", () => {
    const args = pluralArgs(
      "{count, plural, offset:1 =0 {none} one {# thing and {extra, plural, one {# more} other {# more}}} other {# things}}",
    );
    expect(args.map((arg) => arg.name).sort()).toEqual(["count", "extra"]);
    const count = args.find((arg) => arg.name === "count");
    expect([...(count as { categories: Set<string> }).categories].sort()).toEqual([
      "=0",
      "one",
      "other",
    ]);
  });
});
