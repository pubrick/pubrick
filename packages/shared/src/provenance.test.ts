import { describe, expect, it } from "vitest";
import {
  aiSentenceMask,
  aiSentenceMaskAny,
  allSentencesAi,
  dimSpans,
  isUntouchedAi,
  matchesAnyAiVersion,
  normalizeForComparison,
  normalizeNewlines,
  splitSentenceSpans,
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

describe("splitSentenceSpans", () => {
  const corpus = [
    "Hello. World.\n\nSecond line here. Done.",
    "One sentence only",
    "",
    "   ",
    "Цена ниже, т.е. выгодно. Берите.",
    "今天很好。明天更好。",
    "See example.com/x for 2.5x more.",
    "Hook line\nBody line",
    "Trailing newline.\n",
    "Ends without terminator",
    "**Big news.** We ship today.",
    "1. First\n2. Second",
    // Beyond the brief: the shapes most likely to make a partition leak.
    "\n",
    "\n\n\n",
    "\t \u200B\uFEFF",
    "Line one\r\nLine two",
    "Windows.\r\n\r\nSecond para.\r\n",
    ". Leading terminator.",
    "...",
    "Ends mid-abbreviation, т.е.",
    "Bring water, etc.",
    "Mr.",
    "Готово!🔥 Дальше поехали.",
    'He said "Hello."   Then left.',
    "Wait... Really?!",
    "Buy now.\u200B Second one.",
    "Buy now.\uFEFFSecond one.",
    "  Leading space. Trailing space.  ",
    "\n\nHello. World.",
    "  \n Hello. World.",
    "Hello.今天很好。",
    "「こんにちは。」次へ。",
    "สวัสดีครับ ยินดีต้อนรับ",
    "A.\n \n B.",
    "Use the .* wildcard here.",
    "- One item.\n- Two item.",
    "Buy now. #sale #deal",
  ];

  it("partitions the input losslessly — every character, exactly once, in order", () => {
    for (const text of corpus) {
      const spans = splitSentenceSpans(text);
      // Rejoining the slices must reproduce the input byte for byte. This is
      // the assertion the overlay depends on: it renders these slices, so any
      // character the partition drops is a character the highlight misplaces.
      expect(spans.map((s) => text.slice(s.start, s.end)).join(""), text).toBe(text);
      let cursor = 0;
      for (const span of spans) {
        expect(span.start, text).toBe(cursor);
        expect(span.end, text).toBeGreaterThanOrEqual(span.start);
        cursor = span.end;
      }
      expect(cursor, text).toBe(text.length);
    }
  });

  it("keeps splitSentences as the trimmed view of the same partition", () => {
    // Trimmed with the module's own whitespace class, which counts the
    // zero-width space that `String.trim()` leaves behind (U+200B; NOT the
    // BOM, which `\s` matches and `.trim()` strips). With a bare `.trim()` a
    // body of nothing but invisible spacing reads as a disagreement between
    // the two views when there is none.
    //
    // This pins the `splitSentences` side only — the trim-and-filter. It has
    // no power over the partition: both sides are computed from
    // `splitSentenceSpans`, so a change there moves them together and this
    // stays green. The partition's real guards are the losslessness test
    // above, the separator test, and dimSpans' blank-span test.
    const trimSpace = (piece: string) =>
      piece.replace(/^[\s\u200B\uFEFF]+|[\s\u200B\uFEFF]+$/gu, "");
    for (const text of corpus) {
      const fromSpans = splitSentenceSpans(text)
        .map((s) => trimSpace(text.slice(s.start, s.end)))
        .filter((piece) => piece.length > 0);
      expect(fromSpans, text).toEqual(splitSentences(text));
    }
  });

  it("can leave a whitespace-only span, so spans do not index-align with sentences", () => {
    // A leading blank line has no preceding span to attach to, so the
    // partition must emit it on its own — while `splitSentences` drops it.
    // The overlay therefore cannot zip `aiSentenceMask` onto spans by index:
    // here that would dim the blank line and leave the last sentence undimmed,
    // sliding every flag one position off the sentence it describes.
    expect(
      splitSentenceSpans("\n\nHello. World.").map((s) => "\n\nHello. World.".slice(s.start, s.end)),
    ).toEqual(["\n\n", "Hello. ", "World."]);
    expect(splitSentences("\n\nHello. World.")).toEqual(["Hello.", "World."]);
  });

  it("attaches each separator to the preceding span, never to the following one", () => {
    // The overlay dims a span as a unit. A span that opens with the space or
    // newline the previous sentence ended on would dim the gap in front of a
    // human's sentence, and the eye reads that gap as part of the AI's.
    expect(
      splitSentenceSpans("Hello. World.\n\nDone.").map((s) =>
        "Hello. World.\n\nDone.".slice(s.start, s.end),
      ),
    ).toEqual(["Hello. ", "World.\n\n", "Done."]);
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

describe("aiSentenceMaskAny", () => {
  it("ORs the per-version masks", () => {
    const v1 = "Alpha one. Beta two.";
    const v2 = "Gamma three.";
    expect(aiSentenceMaskAny("Alpha one. Gamma three. Mine here.", [v1, v2])).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("keeps each version's multiset counting — a duplicate is not licensed twice", () => {
    // Concatenating the references would mark BOTH copies as AI. Per-version
    // masking keeps the promise aiSentenceMask makes on its own.
    expect(aiSentenceMaskAny("Alpha one. Alpha one.", ["Alpha one. Beta two."])).toEqual([
      true,
      false,
    ]);
  });

  it("does not let two versions license a duplicate the human wrote", () => {
    // The mutation this pins: `aiSentenceMask(current, aiVersions.join("\n"))`.
    // The single-version duplicate case above CANNOT catch it — joining one
    // string changes nothing — so the counting defect only shows with two
    // references that share a sentence. Concatenated, the pool holds two
    // `Alpha one.` and dims both copies; each version wrote it once, so the
    // second copy is the human's.
    expect(
      aiSentenceMaskAny("Alpha one. Alpha one.", [
        "Alpha one. Beta two.",
        "Alpha one. Gamma three.",
      ]),
    ).toEqual([true, false]);
  });

  it("marks nothing when there are no AI versions", () => {
    expect(aiSentenceMaskAny("Anything at all.", [])).toEqual([false]);
  });
});

describe("dimSpans", () => {
  it("does not let a whitespace-only span consume a mask flag", () => {
    // A leading blank line has no preceding span to attach to, so the partition
    // emits it alone while the sentence list drops it. Zipping by index would
    // dim the blank line and never dim the last sentence.
    const ai = "Hello. World.";
    const text = `\n\n${ai}`;
    const spans = dimSpans(text, [ai]);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["\n\n", "Hello. ", "World."]);
    expect(spans.map((s) => s.ai)).toEqual([false, true, true]);
  });

  it("gives each sentence its own flag, not the first sentence's", () => {
    // Every other case here has a uniform mask — all AI or all human — under
    // which `mask[0]` for every span, no increment at all, or a backwards walk
    // are all indistinguishable from the truth. A mixed mask is what separates
    // them. With `mask[0]` everywhere, editing the FIRST sentence undims the
    // whole body, verbatim AI included.
    const ai = "Alpha one. Beta two. Gamma three.";
    const text = "\n\nAlpha one. My own words. Gamma three.";
    expect(dimSpans(text, [ai]).map((s) => s.ai)).toEqual([false, true, false, true]);
  });

  it("walks the mask forwards", () => {
    // Deliberately NOT the fixture above: its mask is [true, false, true],
    // a palindrome, so reversing the mask leaves it unchanged and that
    // mutation survives. This one's is [true, true, false].
    const ai = "Alpha one. Beta two. Gamma three.";
    const text = "\n\nAlpha one. Beta two. My own words.";
    expect(dimSpans(text, [ai]).map((s) => s.ai)).toEqual([false, true, true, false]);
  });

  it("dims against every version, not just the first", () => {
    // aiSentenceMaskAny is tested with many versions; dimSpans was not, so
    // `aiVersions.slice(0, 1)` here would reintroduce one layer up exactly the
    // defect that helper exists to prevent — and it is the likeliest real
    // regression once 2b's refine rows create the second version.
    const text = "Alpha one. Gamma three. Mine here.";
    expect(dimSpans(text, ["Alpha one. Beta two.", "Gamma three."]).map((s) => s.ai)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("stays a lossless partition", () => {
    const text = "Alpha one. Beta two.\n\nGamma three.";
    expect(
      dimSpans(text, [])
        .map((s) => text.slice(s.start, s.end))
        .join(""),
    ).toBe(text);
  });

  it("counts a zero-width character as blank, exactly as splitSentences does", () => {
    // `String.trim()` leaves U+200B standing, so a blank line carrying one
    // would look like content, consume a flag, and shift every later span —
    // the same off-by-one the blank line above pins, reached by a character
    // nobody can see.
    //
    // U+200B is the ONLY such character, and the assertions below pin that:
    // U+FEFF is matched by `\s` and stripped by `.trim()` (ECMAScript's
    // WhiteSpace production includes ZWNBSP), so citing it as a difference is
    // wrong. The fixture carries both because §7's overlay inserts a
    // zero-width character for a trailing newline; only the U+200B does work.
    expect("\u200B".trim()).toBe("\u200B");
    expect("\uFEFF".trim()).toBe("");
    const ai = "Hello. World.";
    const text = `\n\u200B\uFEFF\n${ai}`;
    const spans = dimSpans(text, [ai]);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual([
      "\n\u200B\uFEFF\n",
      "Hello. ",
      "World.",
    ]);
    expect(spans.map((s) => s.ai)).toEqual([false, true, true]);
  });

  it("dims nothing in a body that is entirely whitespace", () => {
    // No sentence at all, so the mask is empty and every span must fall back to
    // human rather than read off the end of it.
    for (const text of ["   ", "\n\n", "\u200B"]) {
      const spans = dimSpans(text, ["Hello."]);
      expect(spans.map((s) => text.slice(s.start, s.end)).join("")).toBe(text);
      expect(spans.every((s) => !s.ai)).toBe(true);
    }
  });

  it("has no spans at all for an empty body", () => {
    expect(dimSpans("", ["Hello."])).toEqual([]);
  });

  it("keeps a trailing separator on the sentence it ends, still dimmed", () => {
    // The partition swallows the trailing whitespace run into the span it
    // closes, so a trailing blank line is not a span of its own — asserted here
    // so a splitter change that starts emitting one is caught by this module,
    // where the alignment decision lives.
    const ai = "Hello. World.";
    const text = `${ai}\n\n`;
    const spans = dimSpans(text, [ai]);
    expect(spans.map((s) => text.slice(s.start, s.end))).toEqual(["Hello. ", "World.\n\n"]);
    expect(spans.map((s) => s.ai)).toEqual([true, true]);
  });

  it("gives every non-blank span exactly one flag, in order", () => {
    // The invariant the whole helper rests on: splitSentences is splitSentenceSpans
    // minus the blank pieces, so non-blank spans and mask entries correspond
    // one to one. If that ever stops holding, this fails before a consumer
    // paints the wrong words.
    const texts = [
      "\n\nHello. World.",
      "One. Two! Three?\n\nFour.",
      "  Leading spaces. Then more.",
      "今天很好。Tomorrow is better.\n\n\nDone.",
      "\n \u200B \n Mixed blanks.\n\nAnd text. ",
    ];
    for (const text of texts) {
      const spans = dimSpans(text, []);
      expect(spans.map((s) => text.slice(s.start, s.end)).join("")).toBe(text);
      const nonBlank = spans.filter(
        (s) => normalizeForComparison(text.slice(s.start, s.end)) !== "",
      );
      expect(nonBlank.length).toBe(splitSentences(text).length);
    }
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

describe("normalizeNewlines", () => {
  /**
   * The one character class the overlay cannot survive, and the reason this
   * function exists rather than living inside the splitter.
   *
   * A `<textarea>` strips CR from its API value while the React string keeps
   * it, so a body carrying one makes the mirror render a different number of
   * characters than the field it sits on. Establishing the canonical form here,
   * and calling it from the DTOs, means no body reaches storage — or the
   * screen, or the publish gate — in a form the two layers disagree about.
   */
  it("rewrites CRLF, a lone CR and a trailing CR to U+000A", () => {
    expect(normalizeNewlines("One.\r\nTwo.")).toBe("One.\nTwo.");
    expect(normalizeNewlines("One.\rTwo.")).toBe("One.\nTwo.");
    expect(normalizeNewlines("One.\r")).toBe("One.\n");
    expect(normalizeNewlines("\rOne.")).toBe("\nOne.");
  });

  it("turns one CRLF into ONE newline, not two", () => {
    // `\r\n?` and not `\r|\n`: the greedy-first alternation is what stops a
    // CRLF from becoming a blank line, which would be a paragraph break the
    // author never typed — and a sentence boundary the splitter then honours.
    expect(normalizeNewlines("A.\r\nB.")).toHaveLength("A.\nB.".length);
    expect(splitSentences("A.\r\n\r\nB.")).toEqual(
      splitSentences(normalizeNewlines("A.\r\n\r\nB.")),
    );
  });

  it("leaves text with no CR untouched, byte for byte", () => {
    const text = "Alpha one.\n\nBeta two.\tTabbed.\u200B";
    expect(normalizeNewlines(text)).toBe(text);
  });

  it("makes a CRLF body and its LF twin the same string, so the mask cannot differ", () => {
    const ai = "Alpha one.\nBeta two.";
    expect(normalizeNewlines("Alpha one.\r\nBeta two.")).toBe(ai);
    expect(isUntouchedAi(normalizeNewlines("Alpha one.\r\nBeta two."), ai)).toBe(true);
  });
});

/**
 * The badge's reference — design §3's middle row. See `matchesAnyAiVersion`'s
 * docstring for why each of the three questions gets its own.
 */
describe("matchesAnyAiVersion", () => {
  it("is true while the body still matches the only ai version", () => {
    expect(matchesAnyAiVersion("Alpha one. Beta two.", ["Alpha one. Beta two."])).toBe(true);
  });

  it("is true when the body matches a LATER version, not the first", () => {
    // The fixture that tells §3's rule apart from the publish gate's. Reading
    // only the first row here would flip an accepted refinement to
    // "human-edited" the moment 2b writes the second row.
    expect(
      matchesAnyAiVersion("A later AI refinement.", [
        "The model's first attempt.",
        "A later AI refinement.",
      ]),
    ).toBe(true);
  });

  it("is false only when the body matches none of them", () => {
    expect(
      matchesAnyAiVersion("I rewrote the whole thing.", [
        "The model's first attempt.",
        "A later AI refinement.",
      ]),
    ).toBe(false);
  });

  it("is true with no versions at all — missing evidence is not evidence of an edit", () => {
    // The fail-safe, and the one an `Array.some` would get backwards. An item
    // whose version row was never written must keep reading AI-drafted;
    // answering "human-edited" would over-claim human authorship on a body
    // nobody has touched.
    expect(matchesAnyAiVersion("Whatever this is.", [])).toBe(true);
  });

  it("never answers a concatenation of the versions", () => {
    // `isUntouchedAi` short-circuits on a sentence-count mismatch, so a joined
    // reference always answers false and would read every AI draft as edited.
    const versions = ["Alpha one.", "Beta two."];
    expect(matchesAnyAiVersion("Alpha one.", versions)).toBe(true);
    expect(isUntouchedAi("Alpha one.", versions.join("\n"))).toBe(false);
  });
});

/**
 * The one question the gate and the badge both ask once refine verbs exist.
 * `true` means "still the model's", which REFUSES an unread draft; `false` says
 * a human was involved and opens the gate. Every case below is written with
 * that direction in mind — a wrong `false` here is a published draft nobody
 * read.
 */
describe("allSentencesAi", () => {
  const full = "Alpha one. Beta two. Gamma three.";

  it("is true while every sentence is still the model's", () => {
    expect(allSentencesAi(full, [full], full)).toBe(true);
  });

  it("is true after a refine — the fragment covers the sentence that changed", () => {
    // The body now equals NO stored row, which is exactly what broke the old
    // equality question: it read a human touch that never happened.
    const refined = "Alpha one. A tighter second line. Gamma three.";
    expect(allSentencesAi(refined, [full, "A tighter second line."], full)).toBe(true);
  });

  it("is false as soon as one sentence is the human's own", () => {
    const edited = "Alpha one. I wrote this myself. Gamma three.";
    expect(allSentencesAi(edited, [full, "A tighter second line."], full)).toBe(false);
  });

  it("is false when a sentence was deleted — a deletion is a human act", () => {
    // Trimming an over-long draft is the commonest API-side edit. Without this
    // clause the mask reports "all AI" for any subset and the caller is refused.
    expect(allSentencesAi("Alpha one. Gamma three.", [full], full)).toBe(false);
  });

  it("refuses when there is no evidence at all", () => {
    expect(allSentencesAi("Anything.", [], undefined)).toBe(true);
  });

  it("refuses when the only evidence is a fragment — the full row is missing", () => {
    expect(allSentencesAi("Alpha one. Beta two.", ["Beta two."], undefined)).toBe(true);
  });

  it("refuses with no rows at all, even were a full row somehow supplied", () => {
    // The other half of the fail-safe, and the half the case above cannot pin:
    // with no rows the `firstFullRow === undefined` check answers true for free,
    // so dropping `aiRows.length === 0` looks harmless. It is not — the mask
    // marks every sentence human against an empty reference, and this function
    // would report "the human wrote all of it" on the strength of no evidence
    // whatsoever. The caller cannot produce this pair today (a full row IS one
    // of the rows), which is exactly why the guard needs pinning here.
    expect(allSentencesAi("Anything.", [], full)).toBe(true);
  });

  it("refuses on a fragment-only level even when the body matches the fragment", () => {
    // The other half of the missing-evidence branch, and the half a
    // `firstFullRow === undefined` check could be dropped without noticing: with
    // no full row there is no count to compare against, so a body that is
    // exactly the fragment is still unjudgeable. `isUntouchedAi` against that
    // fragment would answer true here for the wrong reason — it has no idea a
    // whole draft went missing.
    expect(allSentencesAi("Beta two.", ["Beta two."], undefined)).toBe(true);
  });

  it("is true when a refine ADDED a sentence instead of replacing one", () => {
    // The clause is "nothing was deleted", not "the length never moved". A
    // proposal that appends — a CTA, a closing line — leaves every sentence
    // some row's and nothing missing, so the draft is still unread AI. Written
    // as an equality this reads human-edited and publishes it, which is the
    // inversion the whole increment exists to prevent; a longer body is only
    // ever a human's when the mask says so, and then clause 2 has already
    // answered.
    expect(
      allSentencesAi(`${full} A tighter second line.`, [full, "A tighter second line."], full),
    ).toBe(true);
  });

  it("is false when a human deleted a sentence AND a refine was accepted", () => {
    // The count clause is not "did anything change" — it still sees the
    // deletion through an accepted refine, because one fragment cannot pay for
    // two missing sentences.
    expect(
      allSentencesAi("Alpha one. A tighter second line.", [full, "A tighter second line."], full),
    ).toBe(false);
  });

  it("is false when the body keeps only one of the model's three sentences", () => {
    expect(allSentencesAi("Alpha one.", [full], full)).toBe(false);
  });

  it("judges a full row that is itself a single sentence", () => {
    const solo = "Just the one line.";
    expect(allSentencesAi(solo, [solo], solo)).toBe(true);
    expect(allSentencesAi(`${solo} And mine.`, [solo], solo)).toBe(false);
    // A one-sentence body, refined: the fragment IS the whole row's worth.
    expect(allSentencesAi("A tighter line.", [solo, "A tighter line."], solo)).toBe(true);
  });

  it("is true for a reordered body — the module's accepted false positive", () => {
    // Documented in the module header: a reordered post reads as untouched.
    // Under-claiming human authorship, which refuses rather than publishes.
    expect(allSentencesAi("Gamma three. Alpha one. Beta two.", [full], full)).toBe(true);
  });

  it("is false when a human duplicated a sentence the model wrote once", () => {
    // The multiset in `aiSentenceMask` is what catches this; a set would credit
    // the second copy to an AI original that does not exist.
    expect(allSentencesAi("Alpha one. Alpha one. Beta two. Gamma three.", [full], full)).toBe(
      false,
    );
    // And a duplicate that hides a deletion behind an unchanged sentence count.
    expect(allSentencesAi("Alpha one. Alpha one. Gamma three.", [full], full)).toBe(false);
  });

  it("is true across whitespace-only, zero-width and Unicode-composition noise", () => {
    expect(allSentencesAi("  Alpha one.\u200B  Beta two.   Gamma three. ", [full], full)).toBe(
      true,
    );
    const accented = "Cliché wins. Ёлка зелёная.";
    expect(allSentencesAi(accented.normalize("NFD"), [accented.normalize("NFC")], accented)).toBe(
      true,
    );
  });

  it("is false when a human joined two lines into one", () => {
    // A newline is a sentence boundary, so joining lines is a structural edit:
    // one unit the mask has never seen, and one sentence fewer than the row.
    expect(
      allSentencesAi("Hook line Body line", ["Hook line\nBody line"], "Hook line\nBody line"),
    ).toBe(false);
  });

  it("refuses a body that is empty or entirely whitespace", () => {
    // No sentence to judge is no evidence, and `true` blocks publishing — the
    // answer `isUntouchedAi` gives an empty draft with no version at all. It
    // DISAGREES with `isUntouchedAi("   ", full)`, which reads the emptying as
    // the human act it probably is; refusing is this module's direction, and
    // the recovery is one click. A whitespace-only body is storable (`bodyText`
    // is `min(1)` and does not trim), so this branch is reachable.
    for (const body of ["", "   ", "\n\n", "\u200B"]) {
      expect(allSentencesAi(body, [full], full)).toBe(true);
    }
    expect(isUntouchedAi("   ", full)).toBe(false);
  });

  it("accepts one false positive: a fragment appended while a sentence was deleted", () => {
    // The count is unchanged and every sentence is some row's, so this reads
    // untouched though a human did delete `Gamma three.`. Refusing is the safe
    // side of the ledger; the unsafe mirror — a refine that replaces two
    // sentences with one — is named in the function's docstring as 2b-2's to
    // close, because a fragment row does not record what it replaced.
    expect(
      allSentencesAi(
        "Alpha one. Beta two. A tighter second line.",
        [full, "A tighter second line."],
        full,
      ),
    ).toBe(true);
  });

  it("never opens a gate isUntouchedAi held shut", () => {
    // The safety property of the whole change, stated once: for the one-row
    // shape that is all live data has, the new formula refuses everywhere the
    // old one refused. Every defect this module has ever had ran the other way
    // — untouched AI reading as human — so this is the direction worth pinning.
    // The converse does NOT hold, and must not: the refined body and the
    // whitespace-only body are exactly where the new answer is `true` and the
    // old one `false`.
    const pairs: Array<[string, string]> = [
      ["A one. B two.", "A one. B two."],
      ["A one.  B two. ", "A one. B two."],
      ["A one. Mine.", "A one. B two."],
      ["A one. B two. C three.", "A one. B two."],
      ["A one. C three.", "A one. B two. C three."],
      ["B two. A one.", "A one. B two."],
      ["Same. Same.", "Same. Other."],
      ["", "A one."],
      ["   ", "A one."],
      ["", ""],
      ["Hook line Body line", "Hook line\nBody line"],
      ["Cliché wins.".normalize("NFD"), "Cliché wins."],
      ["今天很好。Tomorrow is worse.", "今天很好。Tomorrow is better."],
      ["Купите воду, еду и т.д. Я переписал.", "Купите воду, еду и т.д. Потом идём."],
      ["Buy now.\u200B Second one.", "Buy now. Second one."],
    ];
    for (const [current, ai] of pairs) {
      if (isUntouchedAi(current, ai)) {
        expect(allSentencesAi(current, [ai], ai), `${current} / ${ai}`).toBe(true);
      }
    }
  });
});
