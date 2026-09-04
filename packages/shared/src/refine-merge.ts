/**
 * What an accepted refine proposal leaves behind — decided once, from strings.
 *
 * A refine takes a range of the stored body and replaces it with text a model
 * wrote. Three facts have to come out of that splice and they are all one
 * computation, so they are computed together rather than in three places that
 * would drift: the merged body, the `fragment` version row that is the
 * product's EVIDENCE that a model wrote those units, and the row's signed
 * `unit_delta` — `n(merged) − n(pre-merge)` — which is what keeps the publish
 * gate's deletion clause from reading a successful *shorten* as a human
 * trimming the draft.
 *
 * It lives in `@pubrick/shared`, takes only strings and returns only data: no
 * database, no HTTP, no model. That is not tidiness. This is the module that
 * decides whether text a machine wrote gets attributed to a person, and the
 * only way to hold that claim is to sweep it over generated corpora — which
 * `refine-merge.test.ts` does, and which is how the three measured failure
 * shapes in `provenance.ts`'s docstring were closed rather than argued about.
 *
 * **Two directions of dishonesty, and both are refused here.**
 *
 *  - *Under-crediting the model.* An unterminated proposal fuses with its
 *    neighbour, and the fused unit is in no version row, so the whole body
 *    reads human-edited — the gate opens on a draft nobody read and the badge
 *    captions the model's own words "Human-edited". The fragment therefore
 *    holds the merged body's units as they came out of the SPLIT, not the
 *    proposal as the model returned it. That closes limits (a) and (b) of
 *    `allSentencesAi`'s docstring; (c) is closed by `unitDelta`.
 *  - *Crediting the model with a person's words.* A merged unit can absorb
 *    characters from outside the replaced range — a human's `Note: ` prefix,
 *    a list marker, the sentence a terminator-less proposal fused with. Where
 *    those characters came from text no model wrote, accepting would file a
 *    human's sentence as the model's: the lens stops dimming it, the badge
 *    reads "AI-drafted" over the author's own words. That is refused, not
 *    approximated.
 *
 * The second is the harder half and it is decided by OFFSETS, never by
 * substring search. "An introduced unit that contains a pre-merge unit" both
 * over- and under-fires: `Note: ` is absorbed without containment, and an
 * unrelated human line that happens to be a textual prefix of the model's
 * output fires a refusal that discards a call somebody paid for. The splice
 * offsets are known exactly, so they are what is used.
 */

import { MAX_BODY_LENGTH } from "./dto/content.js";
import {
  dimSpans,
  isSameText,
  normalizeForComparison,
  normalizeNewlines,
  splitSentenceSpans,
  splitSentences,
} from "./provenance.js";

/**
 * The outcome of accepting a proposal.
 *
 * Two `ok` shapes rather than an optional field, because they ask different
 * things of the caller and a caller that forgets the distinction writes a
 * version row about nothing. Narrow with `"unchanged" in plan` after `plan.ok`.
 *
 *  - `{ mergedBody, fragmentBody, unitDelta }` — update the body, insert one
 *    `ai` `fragment` row holding `fragmentBody` with that `unit_delta`.
 *  - `{ unchanged: true }` — the merged body is not a new version of anything.
 *    Write nothing: no body update, no version row, no ledger consequence.
 *    Precedent and mechanism: `humanVersionBody`, which files no row for a save
 *    `isSameText` cannot tell from the last one.
 *  - `{ ok: false, reason }` — refuse, and (the API's job) leave the staged
 *    proposal in place so the person can act on it rather than lose it. The two
 *    reasons map one-to-one onto `refine_would_launder` and `refine_too_long`,
 *    and they are checked in that order: whether the product may say a model
 *    wrote this is a more useful thing to be told than how long it came out.
 */
export type RefineAcceptPlan =
  | { ok: true; mergedBody: string; fragmentBody: string; unitDelta: number }
  | { ok: true; unchanged: true }
  | { ok: false; reason: "would_launder" | "too_long" };

/**
 * The `ai` version rows of the level being refined, oldest-first or not — the
 * order is irrelevant here, because every question this module asks of them is
 * a per-row count or a per-row mask.
 *
 * Typed as the structural subset it reads rather than as the repository's own
 * `AiVersionRow`. A row's `scope` and `unit_delta` are the publish gate's
 * business; a merge that could read them could come to depend on a field whose
 * meaning it does not own, and an `AiVersionRow[]` still passes unchanged.
 */
export interface AiEvidenceRow {
  readonly body: string;
}

export interface RefineAcceptArgs {
  /**
   * The CURRENT stored body, and the string `start`/`end` index.
   *
   * It is required to be in the canonical form the DTO stores — newlines are
   * U+000A and nothing else — because that is the string the offsets were
   * measured against. The proposal is normalised here instead, since it comes
   * straight from a model and has crossed no schema.
   */
  body: string;
  /** Half-open splice range into `body`; `0 <= start <= end <= body.length`. */
  start: number;
  end: number;
  /** The model's replacement for `body.slice(start, end)`. */
  proposal: string;
  /** Every `ai` version row at this level — the evidence a unit is the model's. */
  aiRows: readonly AiEvidenceRow[];
}

/** Blank under THIS module's whitespace class, U+200B included, not `.trim()`'s. */
function isBlank(text: string): boolean {
  return normalizeForComparison(text) === "";
}

/** One sentence of a body, with the offsets of its trimmed text inside it. */
interface Unit {
  /** Offset of the first non-blank character of the sentence. */
  start: number;
  /** Offset one past its last non-blank character. */
  end: number;
  /** `text.slice(start, end)` — exactly what `splitSentences` yields. */
  text: string;
  /** `normalizeForComparison(text)` — what the mask matches on. */
  key: string;
}

/**
 * The sentences of `text`, each carrying where it sits.
 *
 * Derived from `splitSentenceSpans` and trimmed with this module's own blank
 * test, so `unitsOf(t).map(u => u.text)` is `splitSentences(t)`. That equality
 * is the hinge of everything below — this reasons about units by OFFSET while
 * the mask reasons about them by VALUE, and the two being the same list is the
 * only thing that makes the two readings comparable — so the test file derives
 * its own copy the same way and asserts it against `splitSentences` over the
 * whole sweep corpus, rather than either of them assuming it.
 *
 * The TRIMMED bounds are the ones that matter for "did the splice touch this
 * sentence": a span reaches over the whitespace that follows its terminator,
 * and replacing only that whitespace changes no word and no key.
 */
function unitsOf(text: string): Unit[] {
  const units: Unit[] = [];
  for (const span of splitSentenceSpans(text)) {
    let start = span.start;
    let end = span.end;
    while (start < end && isBlank(text.charAt(start))) start++;
    while (end > start && isBlank(text.charAt(end - 1))) end--;
    if (start >= end) continue;
    const unitText = text.slice(start, end);
    units.push({ start, end, text: unitText, key: normalizeForComparison(unitText) });
  }
  return units;
}

/** How many times each sentence appears in `body`, keyed as the mask keys it. */
function countByKey(body: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const sentence of splitSentences(body)) {
    const key = normalizeForComparison(sentence);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * The largest count any SINGLE row gives each key.
 *
 * The max and not the sum, and that is the whole subtlety of the fragment's
 * contents. `aiSentenceMaskAny` ORs a separate mask per row and each mask
 * consumes that row's own multiset from the start of the body, so two rows
 * holding one copy each still only ever light the FIRST occurrence. Credit for
 * a key is therefore `max` over rows, never `Σ`.
 */
function existingCredit(rowBodies: readonly string[]): Map<string, number> {
  const credit = new Map<string, number>();
  for (const rowBody of rowBodies) {
    for (const [key, count] of countByKey(rowBody)) {
      credit.set(key, Math.max(credit.get(key) ?? 0, count));
    }
  }
  return credit;
}

/**
 * Everything an accepted proposal changes, or the reason it may not be accepted.
 *
 * Pure. Throws only for a range that cannot have come from a real selection —
 * see below; every other outcome is data.
 *
 * The steps, in the order they run and for the reasons they run in it:
 *
 *  1. **Splice.** `merged = body[0,start) + proposal + body[end,…)`, with the
 *     proposal newline-normalised first so a model's CRLF cannot shift every
 *     offset after it. The replaced region in MERGED coordinates is
 *     `[start, start + proposal.length)`, and a merged offset maps back to a
 *     pre-merge one by arithmetic: below `start` it is itself; at or above
 *     `start + proposal.length` it is `m − proposal.length + (end − start)`.
 *  2. **Touched units.** A merged sentence is the splice's work unless it
 *     SURVIVED: lies wholly outside the replaced region AND maps back onto a
 *     pre-merge sentence's exact extent. Overlap alone is too narrow — a range
 *     inside one sentence leaves a remainder that is a brand-new unit sitting
 *     entirely outside the region — and it is too narrow in the unsafe
 *     direction, since a unit nothing claims reads as a person's work.
 *  3. **Nothing to record ⇒ `unchanged`.** Either the splice overlapped no
 *     sentence at all, or the merged body is text `isSameText` cannot tell from
 *     the body it replaced — a *shorten* that hands back the selection, which
 *     is routine on short copy. Nothing is written, so no credit moves, so no
 *     later step has anything to say. It also disposes of the cheapest
 *     laundering attempt there is: a proposal that reproduces a person's own
 *     sentence verbatim files no evidence about it.
 *  4. **Absorption.** For each touched unit, the non-blank characters of it
 *     that lie OUTSIDE the region are mapped back and looked up in
 *     `dimSpans(body, rows)`. If any of them came from a sentence no model
 *     wrote, accepting would file that person's words as the model's, and the
 *     answer is `would_launder`. Blank characters are skipped: a space carries
 *     no authorship, and counting the one after a replaced sentence's full stop
 *     would refuse every refine of a human-written sentence.
 *  5. **Contents and count.** Every key with at least one touched occurrence
 *     goes into the fragment, and it goes in its FULL merged count of times —
 *     not the excess. Two copies of a call-to-action the model wrote once need
 *     two copies in the row, because credit for a key is `max` over rows and a
 *     row with one copy lights only the first occurrence. The key is the
 *     normalised form; the RAW unit is what is stored.
 *  6. **Spillover.** Handing a key its full merged count also lights the
 *     occurrences the splice did not touch. That is legitimate exactly when an
 *     existing row already covered them: `merged(K) − touched(K) <= credit(K)`.
 *     Otherwise the fragment would carry a person's own duplicate of that
 *     sentence into the model's evidence — `would_launder` again, and the one
 *     shape a containment test could never see.
 *  7. **Delta and bound.** `unitDelta` is measured, not inferred:
 *     `n(merged) − n(pre-merge)`. Then the body DTO's own rule, normalise first
 *     and bound second, gives `too_long`. `min(1)` needs no check here — step 3
 *     has already established that `merged` holds a non-blank sentence.
 *
 * **What this deliberately refuses, and the cost is real.** Refining PART of a
 * sentence a human wrote is `would_launder`: the words of theirs the merged
 * unit keeps are absorbed into a unit the fragment would attribute to the
 * model. Selecting the whole sentence is accepted, because then nothing of
 * theirs survives into it. Refusing is the fail-safe direction — the alternative
 * is the badge reading "AI-drafted" over half a person's own line — and the
 * recovery is one re-selection.
 *
 * **`unchanged` can also swallow a real change**, and it is named rather than
 * hidden: a proposal that lands entirely inside the whitespace between two
 * sentences, or one that is empty after normalisation (unreachable through the
 * step's `min(1)` schema), touches no unit. Nothing is written and the body
 * keeps the text it had. Safe in every direction — no attribution is invented —
 * and a later increment that wants those splices applied has to say what
 * evidence it would file for them.
 *
 * **One shape the delta cannot describe, inherited rather than introduced.**
 * `unitDelta` is measured against the body as it stands, and the gate adds the
 * deltas to the first `full` row's count. A human deletion between two refines
 * is therefore permanent in that sum: a later proposal that happens to restore
 * the deleted sentence pushes the running expectation up rather than back, and
 * the gate stays open on a body that is once again entirely the model's. That
 * is `allSentencesAi`'s composition rule, not this module's — recorded here
 * because this is where the number it adds up is authored.
 */
export function planRefineAccept(args: RefineAcceptArgs): RefineAcceptPlan {
  const { body, start, end } = args;
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < start ||
    end > body.length
  ) {
    // A caller bug, not a refusal a reader could act on. Accept re-locates the
    // anchor in the body it has locked and derives the range from it, so an
    // impossible one means the code lied about where the selection was —
    // filing that under "the model tried to launder text" would tell the person
    // a story that is not true.
    throw new RangeError(
      `refine range [${start}, ${end}) is not a slice of a ${body.length}-character body`,
    );
  }

  const proposal = normalizeNewlines(args.proposal);
  const merged = normalizeNewlines(body.slice(0, start) + proposal + body.slice(end));
  const rangeStart = start;
  const rangeEnd = start + proposal.length;
  /** A merged offset outside the spliced region, in pre-merge coordinates. */
  const toPreMerge = (offset: number): number =>
    offset < rangeStart ? offset : offset - rangeEnd + end;

  const rowBodies = args.aiRows.map((row) => row.body);
  const preUnits = unitsOf(body);
  const mergedUnits = unitsOf(merged);
  // A sentence SURVIVED the splice when it is one of the old body's, standing
  // character for character where it stood. Overlapping the replaced region is
  // not the whole of "the splice made this": replacing `Alpha` inside
  // `Alpha one.` leaves `one.` behind as a unit that never existed before, sits
  // entirely outside the region, and is in no version row — so treating it as
  // an old sentence reads the model's own debris as human-written and captions
  // the whole draft "Human-edited". Measured on the sweep below: 928 of the
  // generated merges take that shape, every one of them a mid-sentence range.
  const preExtents = new Set(preUnits.map((unit) => `${unit.start}:${unit.end}`));
  const touched = mergedUnits.map(
    (unit) =>
      (unit.start < rangeEnd && unit.end > rangeStart) ||
      !preExtents.has(`${toPreMerge(unit.start)}:${toPreMerge(unit.end - 1) + 1}`),
  );
  if (!touched.includes(true) || isSameText(body, merged)) return { ok: true, unchanged: true };

  const preSpans = dimSpans(body, rowBodies);
  /**
   * Did every sentence the merged range `[lo, hi)` reaches out to come from a
   * model?
   *
   * Blank characters are trimmed off both ends FIRST, and that is a decision
   * rather than tidiness: the separator after a replaced sentence's full stop
   * belongs to that sentence's span, so counting it would refuse every refine
   * of a person's own sentence — including the ones this module accepts on
   * purpose.
   *
   * `dimSpans`' blank spans then need no special case, and the reason is worth
   * writing down because it looks like an omission. Both ends of the splice are
   * copied verbatim, so a non-blank character of `merged` outside the replaced
   * region is the SAME character in `body` at the mapped offset — the range
   * therefore begins and ends on non-blank text, and a blank span (only ever at
   * the head of a body, since the splitter swallows every other whitespace run
   * into the span it follows) cannot overlap it. Skipping them explicitly was
   * measured SURVIVED against a three-run mutation check, and its absence is
   * the safer half of the pair anyway: were the premise to fail, a blank span
   * carries `ai: false` and this refuses, which is the direction taken
   * everywhere else here.
   */
  const absorbsOnlyAiText = (lo: number, hi: number): boolean => {
    let from = lo;
    let to = hi;
    while (from < to && isBlank(merged.charAt(from))) from++;
    while (to > from && isBlank(merged.charAt(to - 1))) to--;
    if (from >= to) return true;
    const preLo = toPreMerge(from);
    const preHi = toPreMerge(to - 1) + 1;
    for (const span of preSpans) {
      if (span.end <= preLo || span.start >= preHi) continue;
      if (!span.ai) return false;
    }
    return true;
  };
  for (const [index, unit] of mergedUnits.entries()) {
    if (!touched[index]) continue;
    if (!absorbsOnlyAiText(unit.start, Math.min(unit.end, rangeStart))) {
      return { ok: false, reason: "would_launder" };
    }
    if (!absorbsOnlyAiText(Math.max(unit.start, rangeEnd), unit.end)) {
      return { ok: false, reason: "would_launder" };
    }
  }

  const mergedCount = new Map<string, number>();
  const touchedCount = new Map<string, number>();
  for (const [index, unit] of mergedUnits.entries()) {
    mergedCount.set(unit.key, (mergedCount.get(unit.key) ?? 0) + 1);
    if (touched[index]) touchedCount.set(unit.key, (touchedCount.get(unit.key) ?? 0) + 1);
  }
  const credit = existingCredit(rowBodies);
  for (const [key, touchedOccurrences] of touchedCount) {
    const untouchedOccurrences = (mergedCount.get(key) ?? 0) - touchedOccurrences;
    if (untouchedOccurrences > (credit.get(key) ?? 0)) {
      return { ok: false, reason: "would_launder" };
    }
  }

  const fragmentBody = mergedUnits
    .filter((unit) => touchedCount.has(unit.key))
    .map((unit) => unit.text)
    .join("\n");
  const unitDelta = mergedUnits.length - preUnits.length;

  if (merged.length > MAX_BODY_LENGTH) return { ok: false, reason: "too_long" };
  return { ok: true, mergedBody: merged, fragmentBody, unitDelta };
}
