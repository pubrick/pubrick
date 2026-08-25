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

describe("the reference locale itself", () => {
  it("is non-empty, so parity cannot be satisfied by four empty files", () => {
    expect(reference.length).toBeGreaterThan(0);
  });
});
