import { CLAIMS_TO_VERIFY_LABEL } from "@pubrick/shared";
import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import es from "../../messages/es.json";
import pt from "../../messages/pt.json";
import ru from "../../messages/ru.json";

/**
 * The fact-checking step verifies nothing — it lists claims — and the ONE thing
 * standing between that and a user who believes otherwise is what the step is
 * called on screen.
 *
 * `@pubrick/ai` puts `CLAIMS_TO_VERIFY_LABEL` into the step's own instructions
 * ("the list is shown to that person under the heading …"), and this app prints
 * `Runs.step.factcheck` as the step's name in the run checklist. Before this
 * test they were two hand-written strings that happened to agree: renaming the
 * constant left the UI saying the old thing, and renaming the label left the
 * model told the old thing, with a green suite either way.
 *
 * Case-insensitive on purpose: the constant is lowercase because it appears
 * mid-sentence in a prompt, the label is sentence-cased because it is a heading.
 * Everything else about the phrase has to match.
 *
 * ⚠ `@pubrick/shared` resolves from `dist` here, so a renamed constant only
 * shows up after shared is rebuilt — the root `pnpm test` does that for you.
 */
describe("the fact-check step's label", () => {
  it("says exactly what the constant the model is instructed with says", () => {
    expect(en.Runs.step.factcheck.toLowerCase()).toBe(CLAIMS_TO_VERIFY_LABEL);
  });

  /**
   * The three translations cannot be pinned by string equality — they are
   * different languages. What they CAN be held to is the promise the phrase
   * exists to keep: none of them may read as though a check already happened.
   * Guarding the past participle is what catches the tempting one-word
   * "improvement" from "claims to verify" to "verified claims" in a language
   * nobody on the review reads.
   */
  const labels: Array<[locale: string, label: string, forbidden: RegExp[]]> = [
    ["en", en.Runs.step.factcheck, [/\bverified\b/i, /\bchecked\b/i]],
    ["es", es.Runs.step.factcheck, [/verificad[oa]s?\b/i, /comprobad[oa]s?\b/i]],
    ["pt", pt.Runs.step.factcheck, [/verificad[oa]s?\b/i, /checad[oa]s?\b/i]],
    ["ru", ru.Runs.step.factcheck, [/проверен/i, /подтвержд/i]],
  ];

  it.each(labels)("never says in %s that anything was checked", (_locale, label, forbidden) => {
    for (const pattern of forbidden) expect(label).not.toMatch(pattern);
  });
});
