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
