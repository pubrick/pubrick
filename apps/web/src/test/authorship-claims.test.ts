import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import pt from "../../messages/pt.json";
import ru from "../../messages/ru.json";

/**
 * A source is attribution, not verification (CLAUDE.md, provenance). The badge
 * and the lens answer WHO TYPED a sentence and never where it came from, and
 * nothing in the product checks a draft against the material it was pasted
 * from. So no string a reader can see may claim that a draft is original or
 * that anything verified it — a claim like that would be the product's only
 * lie, and it would be one no test of the code could catch, because the code
 * makes no such check to fail.
 *
 * This is the message-catalogue half of that rule, the same shape as the
 * fact-check label's ratchet next door: a word list per locale, over every
 * string. It is crude on purpose — a false positive costs a reworded string,
 * a false negative costs the promise.
 *
 * ONE allowed hit: the fact-check step's own label, "Claims to verify", which
 * names what is NOT done and is itself pinned to the model's instructions.
 */
const CLAIM_WORDS: Record<"en" | "es" | "ru" | "pt", RegExp> = {
  en: /\b(original(ity)?|plagiari[sz]\w*|verified|verifies|verify|fact-?checked)\b/i,
  es: /\b(original(idad)?|plagi\w*|verificad\w*|comprobad\w*)\b/i,
  ru: /(оригинал\w*|плагиат\w*|проверен\w*|проверил\w*|верифицир\w*)/i,
  pt: /\b(original(idade)?|plági\w*|verificad\w*|conferid\w*)\b/i,
};

const ALLOWED = new Set(["Runs.step.factcheck"]);

function* leaves(node: unknown, path = ""): Generator<[string, string]> {
  if (typeof node === "string") {
    yield [path, node];
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      yield* leaves(value, path ? `${path}.${key}` : key);
    }
  }
}

describe("no message claims a draft is original or that anything verified it", () => {
  it.each([
    ["en", en],
    ["es", es],
    ["ru", ru],
    ["pt", pt],
  ] as const)("%s", (locale, messages) => {
    const pattern = CLAIM_WORDS[locale];
    const offending = [...leaves(messages)]
      .filter(([key, text]) => !ALLOWED.has(key) && pattern.test(text))
      .map(([key, text]) => `${key}: ${text}`);
    expect(offending).toEqual([]);
  });

  it("the one allowed hit is still there, so the allowlist is not stale", () => {
    expect(CLAIM_WORDS.en.test(en.Runs.step.factcheck)).toBe(true);
  });
});
