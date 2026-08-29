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
 *
 * Everything else here errs the same way. Where the splitter is unsure, it
 * splits: two units that should have been one still compare verbatim, while one
 * unit that should have been two repaints untouched AI text as human-written the
 * moment a neighbour is edited. `allSentencesAi` and `aiSentenceMask` are
 * derived from the same split for the same reason — there is ONE question here,
 * "is every sentence still the model's", and the publish gate, the origin badge
 * and the per-sentence dimming are three grains of it rather than three rules.
 */

// Zero-width space and byte-order mark are invisible spacing that no human
// types on purpose. `\s` does not cover U+200B — that single character is the
// whole reason this class exists, and the whole difference between it and
// `String.trim()`. It DOES cover U+FEFF: ECMAScript's WhiteSpace production
// includes ZWNBSP, so `/\s/.test("\uFEFF")` is true and `"\uFEFF".trim()` is
// empty. U+FEFF is spelled out below for the reader, not for the engine; do
// not cite it as a difference from `.trim()`, because it is not one.
const SPACE = /[\s\u200B\uFEFF]/u;
const SPACE_RUN = /[\s\u200B\uFEFF]+/gu;
const SPACE_EDGES = /^[\s\u200B\uFEFF]+|[\s\u200B\uFEFF]+$/gu;

const isSpace = (char: string): boolean => SPACE.test(char);
const trimSpace = (text: string): string => text.replace(SPACE_EDGES, "");

/**
 * Collapses whitespace and folds Unicode composition, so that reflowing, an
 * added space, or a copy-paste that arrived as NFD is not an edit.
 *
 * Whitespace is collapsed to a single space, never deleted: deleting it would
 * make `Buynow` equal `Buy now` and report a real edit as untouched AI.
 */
export function normalizeForComparison(text: string): string {
  return text.normalize("NFC").replace(SPACE_RUN, " ").trim();
}

/**
 * Rewrites CRLF and a lone CR to U+000A — the canonical form of every body
 * this module reasons about.
 *
 * This is not cosmetic, and it does not belong to the splitter. A `<textarea>`
 * **strips CR from its API value**: give the element `"One.\r\nTwo."` and
 * `textarea.value` is nine characters, not ten. The provenance lens renders an
 * overlay from slices of the *React string*, so a CR anywhere in a body makes
 * the two layers render different character streams — every highlight after it
 * slides off the words it describes, and the character counter reports a
 * length the field does not hold. Worse, React's `onChange` reads the DOM's
 * normalised value, so a single keystroke anywhere in the field silently
 * rewrites every CR out of the document.
 *
 * So the canonical form is established **at the DTO boundary**, where every
 * writer passes: the public API, the MCP server and a script all reach
 * `content_items.body` through the same schemas. Normalising there covers the
 * publish gate, the mask and the overlay at once — a reference version and the
 * body compared against it are both stored CR-free, and neither can be the
 * odd one out. `DimmedTextarea` normalises again on the way to the screen, for
 * text that arrived by some other road (a model's own output, a row predating
 * this rule).
 *
 * `\r\n?` and not `\r\n|\r`: the first alternative of an alternation wins, so
 * the optional-`\n` form is the one that cannot turn a CRLF into two newlines.
 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

// Abbreviations that end in a period. A title is always followed by the
// capitalised name it introduces, so it never ends a sentence. The rest are
// ordinarily mid-sentence but idiomatically sentence-final too (`и т.д.`,
// `etc.`), and what follows decides — see `startsNewSentence`.
const TITLE_ABBREVIATIONS = ["mr.", "mrs.", "dr."];
const INLINE_ABBREVIATIONS = [
  "т.е.",
  "и т.д.",
  "и т.п.",
  "см.",
  "напр.",
  "e.g.",
  "i.e.",
  "etc.",
  "vs.",
];

const TERMINATORS = ".!?。！？…";
// CJK writes no space after its terminator, so `。` ends a sentence whatever
// follows it — a Latin word, a digit, a bracket.
const CJK_TERMINATORS = "。！？";
// ...and a CJK character (or the fullwidth punctuation that opens a CJK
// sentence) starts one whatever precedes it.
const CJK_START =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[「『（【〈《〔｛]/u;

// Characters that may sit between a terminator and the real boundary: markdown
// emphasis, closing quotes and brackets (CJK's included), and a trailing emoji.
// Social copy is full of `**Hook.** Body` and `Done!🔥 Next` — without this the
// two sentences fuse into one unit, and then a human edit to the second one
// repaints the first, still-verbatim AI sentence as human-written.
const CLOSERS = "\"'”’»›)]}*_`」』）】〉》〕｝";
// Pictographs, their skin-tone modifiers, and the two invisible joiners that
// hold an emoji sequence together (U+FE0F variation selector, U+200D ZWJ).
// An alternation, not a character class: a class mixing base and combining
// characters is flagged as misleading, and rightly so.
const CLOSING_EMOJI = /\p{Extended_Pictographic}|\p{Emoji_Modifier}|\uFE0F|\u200D/u;
// Wrappers that a new sentence may open with, skipped when looking ahead.
const OPENERS = "\"'“‘«‹([{*_";

// `1.` at the head of a line, or an initial like `И.`, is a marker rather than
// a sentence. Without this an everyday numbered list becomes one "sentence" per
// marker, and reordering it lands in the accepted-reorder false positive.
const LIST_MARKER = /^[([]?(?:\d{1,3}|\p{L})$/u;

/** The code point at `index`, as a string, or undefined past the end. */
function codePointAt(text: string, index: number): string | undefined {
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

/**
 * Whether what follows `from` reads as the start of a new sentence: end of
 * text, a capital letter, or a CJK character. Opening wrappers are skipped, so
 * `и т.д. **Потом**` counts.
 */
function startsNewSentence(text: string, from: number): boolean {
  for (let i = from; i < text.length; ) {
    const char = codePointAt(text, i) as string;
    if (isSpace(char) || OPENERS.includes(char)) {
      i += char.length;
      continue;
    }
    return /\p{Lu}/u.test(char) || CJK_START.test(char);
  }
  return true;
}

/** A half-open range of `text`, `text.slice(start, end)`. */
export interface SentenceSpan {
  start: number;
  end: number;
}

/**
 * Splits text into sentence spans: a gapless, ordered partition of the input,
 * where every character belongs to exactly one span and the spans rejoin into
 * the input character for character.
 *
 * Terminators are `.!?。！？…`. A boundary is a terminator — optionally followed
 * by closing wrappers, see `CLOSERS` — followed by whitespace or end of input;
 * a CJK terminator, or a CJK character after any terminator, is a boundary on
 * its own, since CJK writes no space there. A newline is also a boundary:
 * social copy is line-structured and a hook line is its own unit.
 *
 * Separators — the space after a terminator, the newline itself — belong to the
 * span they *end*, never to the one that follows. The overlay dims a span whole,
 * so a leading separator would dim the gap in front of a human's sentence and
 * read as part of the AI's.
 *
 * These offsets are derived, not stored: recomputed from the current text on
 * every use and never persisted. The offsets this module's header refuses are
 * saved ones, which rot on the first edit; a derived one is a loop index.
 *
 * Languages with no sentence terminator at all — Thai, for instance — yield a
 * single span. That is a known limit, not a bug to paper over: provenance
 * there degrades to whole-body comparison and the UI hides the per-sentence
 * view rather than pretending to a granularity it does not have.
 *
 * Two more known limits, both measured rather than assumed:
 *
 * Only U+000A is treated as a line boundary. CR is covered because it is
 * *removed* upstream, by `normalizeNewlines` at the DTO boundary — never
 * because a textarea deals with it. The earlier note here claimed the
 * opposite ("a textarea normalises CRLF on the way in, so that pair is
 * covered"), and it had the consequence backwards: that normalisation happens
 * inside the DOM's value only, which is precisely what makes the overlay and
 * the textarea disagree about how many characters there are. U+2028 and U+2029
 * do survive a paste and are *not* boundaries here — two lines joined by one
 * fuse into a single unit, so editing the second half repaints the untouched
 * first half as human-written. That is under-splitting, the unsafe direction,
 * and it is the first thing to fix if a real body ever arrives carrying one.
 *
 * A CJK terminator is a boundary whatever follows it, so a combining mark
 * sitting on `。` is cut from its base: `好。` + `\u0300more` splits the
 * grapheme cluster and the overlay renders the mark orphaned at the head of
 * the next span. Cosmetic, and only on the CJK path — after an ASCII period a
 * following combining mark blocks the boundary instead.
 */
export function splitSentenceSpans(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  let start = 0;

  /**
   * Closes the current span at `boundaryEnd`, extended over the whitespace run
   * that follows it, and returns the index the scan resumes from. Swallowing
   * that run is what keeps the partition gapless: the old code left it to be
   * trimmed off the front of the next piece, which is precisely the text that
   * went missing.
   */
  const cutAt = (boundaryEnd: number): number => {
    let end = boundaryEnd;
    while (end < text.length && isSpace(text[end] as string)) end++;
    spans.push({ start, end });
    start = end;
    return end;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i] as string;

    if (char === "\n") {
      i = cutAt(i + 1) - 1;
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
    const glued = i > 0 && !isSpace(text[i - 1] as string);
    if (glued) {
      while (end + 1 < text.length) {
        const wrapper = codePointAt(text, end + 1) as string;
        if (!CLOSERS.includes(wrapper) && !CLOSING_EMOJI.test(wrapper)) break;
        end += wrapper.length;
      }
    }

    const cjkTerminated = Array.from(text.slice(i, terminatorEnd + 1)).some((terminator) =>
      CJK_TERMINATORS.includes(terminator),
    );
    const next = codePointAt(text, end + 1);
    const boundary = next === undefined || isSpace(next) || CJK_START.test(next) || cjkTerminated;
    if (!boundary) {
      i = end;
      continue; // example.com/x, 2.5x
    }

    // `1.` / `И.` is a marker, not a sentence. Only for the ASCII period: a
    // single CJK character followed by `。` is a real, if terse, sentence.
    if (text[terminatorEnd] === "." && LIST_MARKER.test(trimSpace(text.slice(start, i)))) {
      i = end;
      continue;
    }

    // The abbreviation test reads the text up to the terminator itself, so a
    // wrapped `**и т.д.**` is still recognised as one.
    const beforeWrappers = text.slice(start, terminatorEnd + 1).toLowerCase();
    const isTitle = TITLE_ABBREVIATIONS.some((abbr) => beforeWrappers.endsWith(abbr));
    const isInline =
      !isTitle &&
      INLINE_ABBREVIATIONS.some((abbr) => beforeWrappers.endsWith(abbr)) &&
      !startsNewSentence(text, end + 1);
    if (isTitle || isInline) {
      i = end;
      continue;
    }

    i = cutAt(end + 1) - 1;
  }

  if (start < text.length) spans.push({ start, end: text.length });
  return spans;
}

/**
 * Splits text into sentences: the trimmed view of `splitSentenceSpans`, with
 * empty pieces dropped. Derived from the partition rather than computed beside
 * it, so the overlay's spans and the provenance comparison can never disagree
 * about where a sentence ends.
 */
export function splitSentences(text: string): string[] {
  const pieces: string[] = [];
  for (const span of splitSentenceSpans(text)) {
    const piece = trimSpace(text.slice(span.start, span.end));
    if (piece) pieces.push(piece);
  }
  return pieces;
}

/**
 * One flag per sentence of `current`: true when that sentence is still exactly
 * what the AI wrote. Matching is a multiset — each AI sentence is consumed at
 * most once — so two copies of a sentence the AI wrote once leave the second
 * copy marked human.
 */
export function aiSentenceMask(current: string, aiVersion: string): boolean[] {
  const unconsumed = new Map<string, number>();
  for (const sentence of splitSentences(aiVersion)) {
    const key = normalizeForComparison(sentence);
    unconsumed.set(key, (unconsumed.get(key) ?? 0) + 1);
  }

  return splitSentences(current).map((sentence) => {
    const key = normalizeForComparison(sentence);
    const left = unconsumed.get(key) ?? 0;
    if (left === 0) return false;
    unconsumed.set(key, left - 1);
    return true;
  });
}

/**
 * One flag per sentence of `current`: true when that sentence is still exactly
 * what *some* AI version wrote.
 *
 * The dimming reference is every `ai` version, not one of them: increment 2b's
 * refine rows add a second. They are NOT concatenated — `aiSentenceMask`
 * consumes each AI sentence at most once on purpose, and a concatenated
 * reference breaks that counting, dimming a human's own duplicate of a sentence
 * the AI wrote once. OR-ing per-version masks keeps every version's own count.
 *
 * (This is the fine grain of the SAME question the gate and the badge ask of
 * the same rows: `allSentencesAi` reads this mask at the grain of the whole
 * text. Two references, one question — never a third formula here.)
 *
 * Note this is a deliberate *exception* to the policy in the module header. In
 * general a human who retypes a sentence identically is credited to the AI —
 * under-claiming human authorship is the safe direction. Here the opposite is
 * chosen: a second copy of a sentence the AI wrote once is credited to the
 * human. The multiset is the reason. Crediting it to the AI would mean
 * inventing an AI original that does not exist, and the count is the only
 * thing standing between "the AI wrote this once" and "the AI wrote this as
 * many times as you paste it".
 */
export function aiSentenceMaskAny(current: string, aiVersions: readonly string[]): boolean[] {
  const sentenceCount = splitSentences(current).length;
  const combined = new Array<boolean>(sentenceCount).fill(false);
  for (const version of aiVersions) {
    const mask = aiSentenceMask(current, version);
    for (let i = 0; i < combined.length; i++) {
      if (mask[i]) combined[i] = true;
    }
  }
  return combined;
}

/** A span of the partition with its dimming decision already made. */
export interface DimSpan extends SentenceSpan {
  ai: boolean;
}

/**
 * The partition of `current`, each span carrying whether it is still AI text.
 *
 * This exists so the alignment between the two lists is decided **once**. The
 * partition and the sentence list do not index-align: `splitSentences` drops
 * every piece that is blank, and a blank piece is emitted whenever there is no
 * preceding span for a whitespace run to attach to — a leading blank line, most
 * commonly. `"\n\nHello. World."` is three spans and two sentences, so zipping
 * the mask on by index dims the blank line and never dims the last sentence.
 * Silent, plausible-looking, and a one-line mistake in every consumer that
 * repeats it.
 *
 * A blank span therefore consumes no mask entry and is never dimmed. "Blank" is
 * this module's own whitespace class, the one `splitSentences` filters with —
 * not `String.trim()`, which leaves U+200B standing. That one character is the
 * entire difference between the two (U+FEFF is *not*: `\s` matches it and
 * `.trim()` strips it), and a blank line carrying one would consume a flag and
 * shift every span after it.
 */
export function dimSpans(current: string, aiVersions: readonly string[]): DimSpan[] {
  const mask = aiSentenceMaskAny(current, aiVersions);
  let sentenceIndex = 0;
  return splitSentenceSpans(current).map((span) => {
    if (!trimSpace(current.slice(span.start, span.end))) return { ...span, ai: false };
    // The fallback is unreachable: every span that gets here is non-blank, and
    // `splitSentences` is exactly the non-blank spans, so there is always an
    // entry left. It is `true` rather than `false` so that if the two ever did
    // drift apart, the failure over-dims — crediting the AI with text a human
    // may have written — rather than painting untouched AI text as human, the
    // direction this module's header refuses.
    return { ...span, ai: mask[sentenceIndex++] ?? true };
  });
}

/**
 * True when nothing in `current` has been touched by a human, judged against
 * ONE version as a whole.
 *
 * Derived from the same split as `aiSentenceMask`, never from a whole-body
 * comparison: normalisation collapses the newline that the splitter treats as a
 * boundary, so a body-level equality can claim "untouched" for a post whose
 * every sentence the mask calls human.
 *
 * **Superseded in production by `allSentencesAi`, and deliberately kept.** It
 * cannot see a refine — a fragment never equals a whole body — so nothing that
 * answers the gate's or the badge's question may call it again. What it is
 * still for is the corpus test that pins the direction of every disagreement
 * between the two formulas: the old answer has to stay computable for the new
 * one to be provably no laxer.
 */
export function isUntouchedAi(current: string, aiVersion: string): boolean {
  const currentSentences = splitSentences(current);
  const aiSentences = splitSentences(aiVersion);
  // Nothing on either side: an empty draft was not written, so it was not
  // touched. `true` blocks publishing, the safe answer for an empty body.
  if (currentSentences.length === 0 && aiSentences.length === 0) return true;
  // A deletion is a human act even though nothing new appeared.
  if (currentSentences.length !== aiSentences.length) return false;
  return aiSentenceMask(current, aiVersion).every((isAi) => isAi);
}

/**
 * Is every sentence of `current` something the model wrote?
 *
 * The question the gate and the badge both ask, and the same evidence the lens
 * paints per sentence — read here at the grain of the whole text. `true` means
 * still the model's, and therefore REFUSES an unread draft; `false` says a
 * human was involved and opens the gate.
 *
 * It replaces the whole-body equality both used to ask, which increment 2b's
 * refine verbs break: an accepted proposal merges a fragment into the body, the
 * body then equals no stored row, and equality reads a human touch that never
 * happened — the gate publishing a draft nobody read, the badge captioning the
 * model's own words "Human-edited".
 *
 * Three clauses, and each is load-bearing:
 *   1. No evidence refuses. An `ai` item whose version rows are missing must not
 *      become approvable, and the mask alone would report every sentence human.
 *      A level with only fragments is also missing its evidence: `firstFullRow`
 *      undefined means we cannot tell a deletion from a rewrite.
 *   2. Nothing new is human — the mask, OR-ed across every `ai` row so an
 *      accepted proposal's fragment covers the sentence it replaced.
 *   3. Nothing was deleted. The mask has no notion of count, so a strict subset
 *      of the model's sentences would otherwise read "all AI" and refuse a
 *      caller who trimmed the draft — with a message telling them to edit it.
 *
 * Clause 3 **counts** against the level's first `full` row; it does not ask that
 * every sentence of that row still appear in the text. Membership is the
 * tempting spelling and it is wrong: a refine REPLACES one of the full row's
 * sentences, so under membership every accepted proposal reads as a deletion and
 * the increment closes nothing. For a body that has PASSED clause 2 the two are
 * the same question — every sentence of such a body matched some row, so "at
 * least as many sentences as the full row had" says exactly "as many
 * fragment-sourced sentences arrived as full-row sentences left". That
 * equivalence is conditional on clause 2, and clause 2 is where the limits
 * below live; it says nothing about a body clause 2 has already refused.
 *
 * The row it counts against is `firstFullRow`, NEVER `aiRows[0]`. Nothing in
 * this signature promises `aiRows` is ordered, and nothing makes a level's
 * `full` row its oldest one either — a re-generation after a refine puts the
 * fragment first however the caller reads them. Then `n >= 1` is
 * true for every body, clause 3 is a no-op, and every deletion publishes and
 * reads as untouched AI. The two arguments exist separately for exactly this
 * reason, and a caller that hands the same list to both has not thought about
 * it: the badge's query had no `ORDER BY` at all until it started asking this
 * question, because the question it asked before ("does the body match ANY
 * row") has no first.
 *
 * An empty or whitespace-only body has no sentence to judge and takes the
 * refusing answer, as `isUntouchedAi` does for an empty draft with no version.
 * That is a deliberate disagreement with `isUntouchedAi` on an empty body that
 * DOES have one, where it reads the emptying as the human act it probably is:
 * this module errs towards refusing, and the recovery is one click. The branch
 * is reachable — `bodyText` is `min(1)` and does not trim, so `"   "` stores.
 * A full row that is itself blank is degenerate evidence and refuses too, for
 * §3's reason: without a countable reference this cannot tell a deletion from a
 * rewrite, and the mask would mark every sentence human against nothing.
 *
 * **The disagreement with `isUntouchedAi` has a direction, and it is a theorem
 * rather than a sample.** For non-empty rows and a full row with at least one
 * sentence: if this answers true with `n(current) > 0`, the mask is all-true, so
 * every sentence of `current` consumed a distinct sentence of some row —
 * against the single-row shape all live data has, that forces
 * `n(current) <= n(ai)`, which with clause 3's `n(current) >= n(ai)` gives
 * equality, which is exactly the old `true`. So `new = false ∧ old = true` is
 * unsatisfiable: every disagreement runs the refusing way, and every one of them
 * has `n(current) = 0`. Pinned over a generated corpus, not over examples.
 *
 * **Three known limits, and all three err UNSAFE — they read the model's own
 * text as human-edited, which opens the gate and captions the badge
 * "Human-edited".** Every one of them is a fragment that does not line up with
 * a sentence boundary, and none is closable here, because a fragment row does
 * not record what it replaced. 2b-2 owns them: re-split at Accept and require
 * every unit of the merged body to be attributable, or refuse the proposal.
 *
 *   a. **An unterminated fragment fuses with its neighbour.** "Make this hook
 *      punchier" is precisely the verb that returns text with no terminator, so
 *      the merged body's partition is NOT the union of the rows' partitions:
 *      `Punchier hook` spliced into `Alpha one. Beta two. Gamma three.` yields
 *      the unit `Punchier hook Gamma three.`, which is in no row. Measured on a
 *      sweep of 108 pure refines (12 fragment shapes × 3 rows × each position):
 *      10 read human-edited, all of this shape, and all with a space separator —
 *      a newline-structured body is immune, because a newline is a boundary
 *      whatever the fragment ends with.
 *   b. **A splice can reshape the unit AROUND it.** `1. Get bread.` is a list
 *      marker plus a sentence; the marker belonged to the old unit and the
 *      sentence to the fragment, so neither row contains the result.
 *   c. **A fragment replacing TWO sentences with one** is indistinguishable
 *      from a deletion, and fails clause 3 rather than clause 2.
 *
 * The mirror case errs safe and is pinned as such: a fragment appended while
 * another sentence is deleted keeps the count and reads untouched.
 */
export function allSentencesAi(
  current: string,
  aiRows: readonly string[],
  firstFullRow: string | null | undefined,
): boolean {
  // `== null`, not `=== undefined`: a caller reading this off a row naturally
  // produces `null`, and a strict check would let it through to throw here
  // rather than take the fail-safe branch it obviously belongs in.
  if (aiRows.length === 0 || firstFullRow == null) return true;
  const reference = splitSentences(firstFullRow);
  if (reference.length === 0) return true;
  const sentences = splitSentences(current);
  if (sentences.length === 0) return true;
  if (!aiSentenceMaskAny(current, aiRows).every((isAi) => isAi)) return false;
  return sentences.length >= reference.length;
}
