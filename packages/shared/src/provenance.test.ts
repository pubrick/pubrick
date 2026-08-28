import { describe, expect, it } from "vitest";
import {
  aiSentenceMask,
  isUntouchedAi,
  normalizeForComparison,
  splitSentences,
} from "./provenance.js";

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
    expect(splitSentences("**Цена ниже, т.е.** выгодно.")).toEqual([
      "**Цена ниже, т.е.** выгодно.",
    ]);
  });

  it("ends the sentence at an abbreviation that is sentence-final", () => {
    // `и т.д.` / `etc.` are idiomatically final. Fusing them with the next
    // sentence is the unsafe direction: an edit to the neighbour would repaint
    // the verbatim AI half as human-written.
    expect(splitSentences("Купите воду, еду и т.д. Потом идём.")).toEqual([
      "Купите воду, еду и т.д.",
      "Потом идём.",
    ]);
    expect(splitSentences("Bring water, food, etc. Then we go.")).toEqual([
      "Bring water, food, etc.",
      "Then we go.",
    ]);
    expect(splitSentences("**Дёшево, и т.д.** Берите.")).toEqual(["**Дёшево, и т.д.**", "Берите."]);
  });

  it("keeps a title glued to the name it introduces", () => {
    // A title is always followed by a capitalised name, so the capital that
    // ends other abbreviations must not end this one.
    expect(splitSentences("Mr. Smith went home. Then slept.")).toEqual([
      "Mr. Smith went home.",
      "Then slept.",
    ]);
    expect(splitSentences("Dr. House knows.")).toEqual(["Dr. House knows."]);
  });

  it("ends a CJK sentence whatever follows the terminator", () => {
    // CJK writes no space after `。`, so the character after it decides
    // nothing — the terminator itself is the boundary.
    expect(splitSentences("「こんにちは。」次へ。")).toEqual(["「こんにちは。」", "次へ。"]);
    expect(splitSentences("今天很好。Tomorrow is better.")).toEqual([
      "今天很好。",
      "Tomorrow is better.",
    ]);
    expect(splitSentences("今天很好。2026年更好。")).toEqual(["今天很好。", "2026年更好。"]);
    expect(splitSentences("今天很好。（明天）更好。")).toEqual(["今天很好。", "（明天）更好。"]);
    // And the mirror image: a Latin terminator followed by CJK, which is how
    // Chinese copy quoting an English phrase reads.
    expect(splitSentences("Hello.今天很好。")).toEqual(["Hello.", "今天很好。"]);
  });

  it("treats a zero-width space as whitespace, not as content", () => {
    expect(splitSentences("Buy now.\u200B Second one.")).toEqual(["Buy now.", "Second one."]);
    expect(splitSentences("Buy now.\uFEFFSecond one.")).toEqual(["Buy now.", "Second one."]);
  });

  it("does not turn a list marker or an initial into a sentence", () => {
    // Otherwise an everyday numbered list is all markers, and reordering it
    // lands in the accepted-reorder false positive.
    expect(splitSentences("1. First\n2. Second")).toEqual(["1. First", "2. Second"]);
    expect(splitSentences("И. Иванов пришёл.")).toEqual(["И. Иванов пришёл."]);
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
      "Купите воду, еду и т.д. Потом идём.",
      "Mr. Smith went home. Then slept.",
      "「こんにちは。」次へ。",
      "今天很好。（明天）更好。",
      "1. First\n2. Second",
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

  it("keeps the sentence before a final abbreviation AI when the next one is rewritten", () => {
    expect(
      aiSentenceMask("Купите воду, еду и т.д. Я переписал.", "Купите воду, еду и т.д. Потом идём."),
    ).toEqual([true, false]);
  });

  it("keeps the CJK half AI when only the half after it is rewritten", () => {
    expect(aiSentenceMask("今天很好。Tomorrow is worse.", "今天很好。Tomorrow is better.")).toEqual(
      [true, false],
    );
    expect(aiSentenceMask("「こんにちは。」またね。", "「こんにちは。」次へ。")).toEqual([
      true,
      false,
    ]);
    expect(aiSentenceMask("Hello.今天不好。", "Hello.今天很好。")).toEqual([true, false]);
  });

  it("licenses exactly as many duplicates as the AI actually wrote", () => {
    // Dies the moment consumption stops decrementing: the third `Same.` would
    // be credited to an AI original that does not exist.
    expect(aiSentenceMask("Same. Same. Same.", "Same. Same. Other.")).toEqual([true, true, false]);
    expect(aiSentenceMask("Same. Same.", "Same. Same.")).toEqual([true, true]);
  });

  it("sees through a Unicode normalisation difference, which no human typed", () => {
    const ai = "Cliché wins. Buy now.";
    expect(aiSentenceMask(ai.normalize("NFD"), ai.normalize("NFC"))).toEqual([true, true]);
    const ru = "Ёлка зелёная. Снег белый.";
    expect(aiSentenceMask(ru.normalize("NFD"), ru.normalize("NFC"))).toEqual([true, true]);
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

  it("is false when a human joined two lines into one", () => {
    // A newline is a sentence boundary, so joining lines is a structural edit.
    // Answering `true` here (as a whole-body comparison does, since it collapses
    // the newline) would contradict the mask, which sees one changed unit.
    expect(isUntouchedAi("Hook line Body line", "Hook line\nBody line")).toBe(false);
  });

  it("is true across a Unicode normalisation difference, which no human typed", () => {
    // Erring the other way opens the publish gate on text nobody touched.
    const en = "Cliché wins. Buy now.";
    expect(isUntouchedAi(en.normalize("NFD"), en.normalize("NFC"))).toBe(true);
    const ru = "Ёлка зелёная. Снег белый.";
    expect(isUntouchedAi(ru.normalize("NFD"), ru.normalize("NFC"))).toBe(true);
  });

  it("is true across an invisible zero-width space", () => {
    expect(isUntouchedAi("Buy now.\u200B Second one.", "Buy now. Second one.")).toBe(true);
  });

  it("never disagrees with the mask it is derived from", () => {
    // The badge and the per-sentence dimming are one product promise. If the
    // badge says untouched, every sentence must be dimmed as AI, and vice
    // versa — pinned across the cases where the two used to diverge.
    const pairs: Array<[string, string]> = [
      ["Hook line Body line", "Hook line\nBody line"],
      ["Hook line\nBody line", "Hook line Body line"],
      ["A one. B two.", "A one. B two."],
      ["A one.  B two. ", "A one. B two."],
      ["A one. Mine.", "A one. B two."],
      ["A one. B two. C three.", "A one. B two."],
      ["A one. C three.", "A one. B two. C three."],
      ["B two. A one.", "A one. B two."],
      ["Same. Same.", "Same. Other."],
      ["", "A one."],
      ["   ", "A one."],
      ["Cliché wins.".normalize("NFD"), "Cliché wins."],
      ["今天很好。Tomorrow is worse.", "今天很好。Tomorrow is better."],
      ["Купите воду, еду и т.д. Я переписал.", "Купите воду, еду и т.д. Потом идём."],
    ];
    for (const [current, ai] of pairs) {
      const mask = aiSentenceMask(current, ai);
      const everySentenceIsAi = mask.length > 0 && mask.every((isAi) => isAi);
      const sameCount = splitSentences(current).length === splitSentences(ai).length;
      expect(isUntouchedAi(current, ai)).toBe(everySentenceIsAi && sameCount);
    }
  });
});

describe("normalizeForComparison", () => {
  it("collapses a whitespace run to one space instead of deleting it", () => {
    expect(normalizeForComparison("Buy   now")).toBe("Buy now");
    expect(normalizeForComparison("Buy\n\tnow")).toBe("Buy now");
  });

  it("trims the ends", () => {
    expect(normalizeForComparison("  Buy now \n ")).toBe("Buy now");
  });

  it("folds invisible spacing characters", () => {
    expect(normalizeForComparison("Buy\u200Bnow")).toBe("Buy now");
    expect(normalizeForComparison("\uFEFFBuy now")).toBe("Buy now");
  });

  it("normalises to NFC, so one word has one form", () => {
    expect(normalizeForComparison("Cliché".normalize("NFD"))).toBe("Cliché".normalize("NFC"));
    expect(normalizeForComparison("ёлка".normalize("NFD"))).toBe("ёлка".normalize("NFC"));
  });

  it("does not fuse words, so a deleted space stays a human edit", () => {
    // Deleting whitespace instead of collapsing it reports a real edit as
    // untouched AI — the direction that unlocks the publish gate.
    expect(normalizeForComparison("Buy now")).not.toBe(normalizeForComparison("Buynow"));
    expect(isUntouchedAi("Buynow. Second one.", "Buy now. Second one.")).toBe(false);
  });
});
