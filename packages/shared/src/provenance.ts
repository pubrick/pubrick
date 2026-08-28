/**
 * Provenance without character offsets.
 *
 * Offsets rot on the first edit, so instead the AI's own output is kept as a
 * version row and "AI text" means "a sentence still identical to what the AI
 * wrote". Two false positives are accepted deliberately: a human who retypes a
 * sentence identically is credited to the AI, and a reordered post reads as
 * untouched. Both under-claim human authorship rather than over-claiming it,
 * which is the safe direction for a product whose promise is that AI text is
 * visible.
 */

/** Collapses whitespace so that reflowing or an added space is not an edit. */
export function normalizeForComparison(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

// Abbreviations that end in a period and must not end a sentence. Russian is a
// shipped locale and `т.е.` / `и т.д.` are common in ordinary copy.
const ABBREVIATIONS = [
  "т.е.",
  "и т.д.",
  "и т.п.",
  "см.",
  "напр.",
  "e.g.",
  "i.e.",
  "etc.",
  "vs.",
  "Mr.",
  "Mrs.",
  "Dr.",
];

const CJK = /[぀-ヿ㐀-䶿一-鿿]/u;

const TERMINATORS = ".!?。！？…";

// Characters that may sit between a terminator and the real boundary: markdown
// emphasis, closing quotes and brackets, and a trailing emoji (plus the joiners
// that hold a multi-code-point emoji together). Social copy is full of
// `**Hook.** Body` and `Done!🔥 Next` — without this the two sentences fuse
// into one unit, and then a human edit to the second one repaints the first,
// still-verbatim AI sentence as human-written. That is the one direction this
// module must not err in.
const CLOSERS = "\"'”’»›)]}*_`";
// Pictographs, their skin-tone modifiers, and the two invisible joiners that
// hold an emoji sequence together (U+FE0F variation selector, U+200D ZWJ).
// An alternation, not a character class: a class mixing base and combining
// characters is flagged as misleading, and rightly so.
const CLOSING_EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D/u;

/**
 * Splits text into sentences.
 *
 * Terminators are `.!?。！？…`, and a boundary is a terminator — optionally
 * followed by closing wrappers, see `CLOSERS` — followed by whitespace, end of
 * input, or a CJK character (Chinese and Japanese put no space after `。`). A
 * newline is also a boundary: social copy is line-structured and a hook line is
 * its own unit.
 *
 * Languages with no sentence terminator at all — Thai, for instance — yield a
 * single sentence. That is a known limit, not a bug to paper over: provenance
 * there degrades to whole-body comparison and the UI hides the per-sentence
 * view rather than pretending to a granularity it does not have.
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;

    if (char === "\n") {
      const piece = text.slice(start, i).trim();
      if (piece) out.push(piece);
      start = i + 1;
      continue;
    }

    if (!TERMINATORS.includes(char)) continue;

    // Consume a run of terminators ("...", "?!").
    let end = i;
    while (end + 1 < text.length && TERMINATORS.includes(text[end + 1] as string)) end++;
    const terminatorEnd = end;

    // Then a run of closing wrappers — but only when the terminator is glued to
    // the word it ends. `Use the .* wildcard here.` has a space before the dot,
    // and must stay one sentence rather than breaking after `.*`.
    const glued = i > 0 && !/\s/u.test(text[i - 1] as string);
    if (glued) {
      while (end + 1 < text.length) {
        const codePoint = text.codePointAt(end + 1) as number;
        const wrapper = String.fromCodePoint(codePoint);
        if (!CLOSERS.includes(wrapper) && !CLOSING_EMOJI.test(wrapper)) break;
        end += wrapper.length;
      }
    }

    const next = text[end + 1];
    const boundary = next === undefined || /\s/u.test(next) || CJK.test(next);
    if (!boundary) {
      i = end;
      continue; // example.com/x, 2.5x
    }

    const candidate = text.slice(start, end + 1);
    // The abbreviation test looks at the text up to the terminator itself, so a
    // wrapped `**и т.д.**` is still recognised as an abbreviation.
    const trimmed = text.slice(start, terminatorEnd + 1).trimStart();
    if (ABBREVIATIONS.some((abbr) => trimmed.toLowerCase().endsWith(abbr.toLowerCase()))) {
      i = end;
      continue;
    }

    const piece = candidate.trim();
    if (piece) out.push(piece);
    start = end + 1;
    i = end;
  }

  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * One flag per sentence of `current`: true when that sentence is still exactly
 * what the AI wrote. Matching is a multiset with positional preference — each
 * AI sentence is consumed at most once, nearest index first — so a duplicated
 * sentence is not licensed twice by a single AI original.
 */
export function aiSentenceMask(current: string, aiVersion: string): boolean[] {
  const aiSentences = splitSentences(aiVersion).map(normalizeForComparison);
  const available = new Map<string, number[]>();
  aiSentences.forEach((sentence, index) => {
    const slot = available.get(sentence);
    if (slot) slot.push(index);
    else available.set(sentence, [index]);
  });

  return splitSentences(current).map((sentence, index) => {
    const key = normalizeForComparison(sentence);
    const slots = available.get(key);
    if (!slots || slots.length === 0) return false;
    // Nearest-index-first keeps an in-place sentence matched to its own original.
    let best = 0;
    for (let i = 1; i < slots.length; i++) {
      if (Math.abs((slots[i] as number) - index) < Math.abs((slots[best] as number) - index))
        best = i;
    }
    slots.splice(best, 1);
    return true;
  });
}

/** True when nothing in `current` has been touched by a human. */
export function isUntouchedAi(current: string, aiVersion: string): boolean {
  if (normalizeForComparison(current) === normalizeForComparison(aiVersion)) return true;
  const mask = aiSentenceMask(current, aiVersion);
  if (mask.length === 0 || mask.some((isAi) => !isAi)) return false;
  // Every sentence is the AI's, but a sentence may have been deleted; a deletion
  // is a human act even though nothing new appeared.
  return splitSentences(current).length === splitSentences(aiVersion).length;
}
