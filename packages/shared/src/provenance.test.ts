import { describe, expect, it } from "vitest";
import { aiSentenceMask, isUntouchedAi, splitSentences } from "./provenance.js";

describe("splitSentences", () => {
  it("splits English on terminator plus space", () => {
    expect(splitSentences("One. Two! Three?")).toEqual(["One.", "Two!", "Three?"]);
  });

  it("does not split Russian abbreviations", () => {
    expect(splitSentences("Цена ниже, т.е. выгодно. Берите.")).toEqual([
      "Цена ниже, т.е. выгодно.",
      "Берите.",
    ]);
  });

  it("splits Chinese, which has no space after the terminator", () => {
    expect(splitSentences("今天很好。明天更好。")).toEqual(["今天很好。", "明天更好。"]);
  });

  it("does not split inside a URL or a decimal", () => {
    expect(splitSentences("See example.com/x for 2.5x more.")).toEqual([
      "See example.com/x for 2.5x more.",
    ]);
  });

  it("treats a newline as a boundary, because social posts are line-structured", () => {
    expect(splitSentences("Hook line\nBody line")).toEqual(["Hook line", "Body line"]);
  });

  it("yields nothing for an empty or whitespace-only body", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   \n\t  ")).toEqual([]);
  });

  it("yields one sentence for a script with no terminator at all", () => {
    // Thai writes no sentence-final punctuation; provenance degrades to
    // whole-body comparison rather than inventing boundaries.
    expect(splitSentences("สวัสดีครับ ยินดีต้อนรับ")).toEqual(["สวัสดีครับ ยินดีต้อนรับ"]);
    expect(splitSentences("just a hook line")).toEqual(["just a hook line"]);
  });

  it("ends the sentence through markdown emphasis, quotes and brackets", () => {
    expect(splitSentences("**Big news.** We ship today.")).toEqual([
      "**Big news.**",
      "We ship today.",
    ]);
    expect(splitSentences("_Big news._ We ship today.")).toEqual(["_Big news._", "We ship today."]);
    expect(splitSentences('He said "Hello." Then left.')).toEqual([
      'He said "Hello."',
      "Then left.",
    ]);
    expect(splitSentences("(Big news.) We ship today.")).toEqual(["(Big news.)", "We ship today."]);
  });

  it("ends the sentence through an emoji glued to the terminator", () => {
    expect(splitSentences("Готово!🔥 Дальше поехали.")).toEqual(["Готово!🔥", "Дальше поехали."]);
    expect(splitSentences("Done!👍🏽 Next up.")).toEqual(["Done!👍🏽", "Next up."]);
  });

  it("does not treat a detached terminator plus wrapper as a sentence end", () => {
    // The wrapper run only applies to a terminator glued to its word, or
    // `.*` and `?!` in ordinary prose would each end a sentence.
    expect(splitSentences("Use the .* wildcard here.")).toEqual(["Use the .* wildcard here."]);
  });

  it("keeps an abbreviation an abbreviation even inside markdown emphasis", () => {
    expect(splitSentences("**Дёшево, и т.д.** Берите.")).toEqual(["**Дёшево, и т.д.** Берите."]);
  });

  it("never drops text: the pieces reassemble into the input, whitespace aside", () => {
    const samples = [
      "One. Two! Three?",
      "Цена ниже, т.е. выгодно. Берите.",
      "今天很好。明天更好。",
      "See example.com/x for 2.5x more.",
      "Hook line\nBody line",
      "**Big news.** We ship today.",
      "Готово!🔥 Дальше поехали.",
      "Wait... Really?!",
      "- One item.\n- Two item.",
      "Buy now. #sale #deal",
      "สวัสดีครับ",
      "",
      "   ",
    ];
    const stripped = (value: string) => value.replace(/\s+/gu, "");
    for (const sample of samples) {
      expect(stripped(splitSentences(sample).join(""))).toBe(stripped(sample));
    }
  });
});

describe("aiSentenceMask", () => {
  const ai = "First sentence. Second sentence. Third sentence.";

  it("marks untouched sentences as AI and edited ones as human", () => {
    const current = "First sentence. My own words here. Third sentence.";
    expect(aiSentenceMask(current, ai)).toEqual([true, false, true]);
  });

  it("consumes each AI sentence at most once, so a duplicate is not licensed twice", () => {
    const current = "First sentence. First sentence.";
    expect(aiSentenceMask(current, ai)).toEqual([true, false]);
  });

  it("still recognises reordered AI sentences (an accepted false positive)", () => {
    const current = "Third sentence. First sentence.";
    expect(aiSentenceMask(current, ai)).toEqual([true, true]);
  });

  it("ignores whitespace differences", () => {
    expect(aiSentenceMask("First   sentence.", "First sentence.")).toEqual([true]);
  });

  it("marks what survives a deletion as AI, since the survivors are verbatim", () => {
    expect(aiSentenceMask("First sentence. Third sentence.", ai)).toEqual([true, true]);
  });

  it("has no flags for an empty body and no AI credit when there is no AI version", () => {
    expect(aiSentenceMask("", ai)).toEqual([]);
    expect(aiSentenceMask("   ", ai)).toEqual([]);
    expect(aiSentenceMask("First sentence.", "")).toEqual([false]);
  });

  it("keeps a markdown-wrapped AI sentence AI when only its neighbour is edited", () => {
    // The whole point of splitting through wrappers: without it these two fuse
    // into one unit and the untouched hook is repainted as human-written.
    expect(
      aiSentenceMask("**Big news.** We ship tomorrow.", "**Big news.** We ship today."),
    ).toEqual([true, false]);
    expect(aiSentenceMask("Готово!🔥 Дальше едем.", "Готово!🔥 Дальше поехали.")).toEqual([
      true,
      false,
    ]);
  });
});

describe("isUntouchedAi", () => {
  it("is true when every sentence is still the AI's", () => {
    expect(isUntouchedAi("A one. B two.", "A one. B two.")).toBe(true);
  });

  it("is true across pure whitespace edits — a stray space is not a human touch", () => {
    expect(isUntouchedAi("A one.  B two. ", "A one. B two.")).toBe(true);
  });

  it("is false once any sentence changed", () => {
    expect(isUntouchedAi("A one. Mine.", "A one. B two.")).toBe(false);
  });

  it("is false when a sentence was added", () => {
    expect(isUntouchedAi("A one. B two. C three.", "A one. B two.")).toBe(false);
  });

  it("is false when a sentence was deleted, even though the rest is verbatim", () => {
    expect(isUntouchedAi("A one. C three.", "A one. B two. C three.")).toBe(false);
    // Deleting and reordering at once is still a deletion.
    expect(isUntouchedAi("C three. A one.", "A one. B two. C three.")).toBe(false);
  });

  it("is false when the human emptied the body", () => {
    expect(isUntouchedAi("", "A one. B two.")).toBe(false);
    expect(isUntouchedAi("   \n ", "A one. B two.")).toBe(false);
  });

  it("is true for an empty body with no AI version — there is nothing to publish", () => {
    // `true` blocks publishing, which is the safe answer for an empty draft.
    expect(isUntouchedAi("", "")).toBe(true);
  });

  it("compares whole bodies when the language has no sentence terminator", () => {
    expect(isUntouchedAi("สวัสดีครับ", "สวัสดีครับ")).toBe(true);
    expect(isUntouchedAi("just my hook line", "just a hook line")).toBe(false);
  });
});
