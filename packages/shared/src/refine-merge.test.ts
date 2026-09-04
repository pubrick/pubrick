import { describe, expect, it } from "vitest";
import { MAX_BODY_LENGTH } from "./dto/content.js";
import {
  aiSentenceMaskAny,
  normalizeForComparison,
  splitSentenceSpans,
  splitSentences,
} from "./provenance.js";
import { planRefineAccept, type RefineAcceptPlan } from "./refine-merge.js";

/** The `ok` plan, or a failure naming what came back instead of one. */
function accepted(plan: RefineAcceptPlan): Extract<RefineAcceptPlan, { fragmentBody: string }> {
  if (!plan.ok) throw new Error(`expected a plan, got a "${plan.reason}" refusal`);
  if ("unchanged" in plan) throw new Error("expected a plan, got `unchanged`");
  return plan;
}

/**
 * Accept a proposal over the one occurrence of `select`.
 *
 * The uniqueness assertion is not decoration. A fixture whose selection appears
 * twice would splice the first one while the test's author reasoned about the
 * second, and the test would then pass or fail for a reason nobody wrote down —
 * which is the exact shape of the redaction guard whose input was wrong in two
 * ways at once and passed whether the guard ran or not.
 */
function refine(args: {
  body: string;
  select: string;
  proposal: string;
  rows: readonly string[];
}): RefineAcceptPlan {
  const start = args.body.indexOf(args.select);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(args.body.lastIndexOf(args.select)).toBe(start);
  return planRefineAccept({
    body: args.body,
    start,
    end: start + args.select.length,
    proposal: args.proposal,
    aiRows: args.rows.map((body) => ({ body })),
  });
}

/** The trimmed extent of every sentence — the test's own eyes on offsets. */
function unitSpans(text: string): { start: number; end: number; text: string }[] {
  const blank = (char: string): boolean => normalizeForComparison(char) === "";
  const units: { start: number; end: number; text: string }[] = [];
  for (const span of splitSentenceSpans(text)) {
    let start = span.start;
    let end = span.end;
    while (start < end && blank(text.charAt(start))) start++;
    while (end > start && blank(text.charAt(end - 1))) end--;
    if (start < end) units.push({ start, end, text: text.slice(start, end) });
  }
  return units;
}

describe("planRefineAccept — what the fragment row is made of", () => {
  it("gives a duplicated unit its FULL merged count, and the mask is the proof", () => {
    // §6's rule, and the one that is easy to get wrong: the mask ORs a separate
    // per-row mask and each consumes its own multiset from the top, so a row
    // holding one copy can only ever light the FIRST occurrence. Two copies in
    // the merged body therefore need two in the row — the excess is not enough.
    const full = "Intro line. CTA now.";
    const plan = accepted(
      refine({ body: full, select: "Intro line.", proposal: "CTA now.", rows: [full] }),
    );
    expect(plan.mergedBody).toBe("CTA now. CTA now.");
    expect(splitSentences(plan.fragmentBody)).toEqual(["CTA now.", "CTA now."]);

    // The row's contents are a means. This is the end:
    expect(aiSentenceMaskAny(plan.mergedBody, [full, plan.fragmentBody])).toEqual([true, true]);
    // ...and it is not vacuous — storing the excess instead leaves the second
    // copy reading human, which is the "Human-edited" badge over the model's
    // own words that this increment exists to prevent.
    expect(aiSentenceMaskAny(plan.mergedBody, [full, "CTA now."])).toEqual([true, false]);
  });

  it("stores the RAW unit and matches on the normalised one", () => {
    const full = "Alpha one. Beta two.";
    const plan = accepted(
      refine({ body: full, select: "Beta two.", proposal: "Cliché  wins.", rows: [full] }),
    );
    // Two spaces and an NFC-composed é survive into the row verbatim; the key
    // that decided the row's membership was the collapsed, composed form.
    expect(plan.fragmentBody).toBe("Cliché  wins.");
    expect(aiSentenceMaskAny(plan.mergedBody, [full, plan.fragmentBody])).toEqual([true, true]);
  });

  it("records a unit the rows already cover, because the DELTA still has to be filed", () => {
    // A shorten that hands back one of the two sentences it was given. Nothing
    // new is attributable — the full row already covers it — but the body lost
    // a unit, and `unit_delta` is the only thing that stops the gate reading
    // that loss as a human trimming the draft. A membership rule that asked
    // "is this key already credited?" would file no row at all here.
    const full = "Alpha one. Beta two.";
    const plan = accepted(
      refine({ body: full, select: full, proposal: "Alpha one.", rows: [full] }),
    );
    expect(plan.mergedBody).toBe("Alpha one.");
    expect(plan.fragmentBody).toBe("Alpha one.");
    expect(plan.unitDelta).toBe(-1);
    expect(splitSentences(plan.mergedBody).length).toBe(
      splitSentences(full).length + plan.unitDelta,
    );
  });

  it("leaves an untouched human sentence out of the row entirely", () => {
    // The splice is nowhere near it, so the fragment has nothing to say about
    // it. A membership rule reading "every merged key the rows do not already
    // cover" — which is how the fragment's contents were first described —
    // would sweep this person's own line into the model's evidence, and the
    // lens would stop dimming it. The mask's third entry is the whole test.
    const full = "Grand opening.\nSee you there.";
    const body = "Grand opening.\nSee you there.\nBring a friend.";
    const plan = accepted(
      refine({ body, select: "See you there.", proposal: "Doors at six.", rows: [full] }),
    );
    expect(plan.fragmentBody).toBe("Doors at six.");
    expect(aiSentenceMaskAny(plan.mergedBody, [full, plan.fragmentBody])).toEqual([
      true,
      true,
      false,
    ]);
  });
});

describe("planRefineAccept — the join is a newline", () => {
  it("re-splits into exactly the units it was built from", () => {
    // `splitSentenceSpans` cuts at `\n` unconditionally, BEFORE any terminator
    // logic. A space join would fuse an unterminated first unit into its
    // neighbour, the row would hold a sentence the merged body does not have,
    // and the two real units would both read human.
    const full = "Alpha one.\nBeta two.\nGamma three.";
    const plan = accepted(
      refine({ body: full, select: "Beta two.", proposal: "Punchy hook\nAnd more.", rows: [full] }),
    );
    expect(splitSentences(plan.fragmentBody)).toEqual(["Punchy hook", "And more."]);
    // Why the join has to be this one, stated as a fact about the splitter:
    expect(splitSentences("Punchy hook And more.")).toEqual(["Punchy hook And more."]);
    expect(aiSentenceMaskAny(plan.mergedBody, [full, plan.fragmentBody]).every(Boolean)).toBe(true);
    expect(aiSentenceMaskAny(plan.mergedBody, [full, "Punchy hook And more."])).toEqual([
      true,
      false,
      false,
      true,
    ]);
  });

  it("round-trips units that carry no terminator, a closing emoji, a marker, or CJK", () => {
    const cases: [body: string, select: string, proposal: string, pieces: string[]][] = [
      ["Hook.\nTail.", "Hook.", "No terminator\nStill none", ["No terminator", "Still none"]],
      ["Hook.\nTail.", "Hook.", "Done!🔥\nNext up.", ["Done!🔥", "Next up."]],
      [
        "Hook.\nTail.",
        "Hook.",
        "1. First step.\n2. Second step.",
        ["1. First step.", "2. Second step."],
      ],
      ["今天很好。\n明天更好。", "今天很好。", "早上好。晚上好。", ["早上好。", "晚上好。"]],
    ];
    for (const [body, select, proposal, pieces] of cases) {
      const plan = accepted(refine({ body, select, proposal, rows: [body] }));
      expect(splitSentences(plan.fragmentBody)).toEqual(pieces);
      expect(aiSentenceMaskAny(plan.mergedBody, [body, plan.fragmentBody]).every(Boolean)).toBe(
        true,
      );
    }
  });
});

describe("planRefineAccept — nothing to record", () => {
  it("writes nothing when the proposal hands back the selection", () => {
    const full = "Alpha one. Beta two.";
    expect(
      refine({ body: full, select: "Beta two.", proposal: "Beta two.", rows: [full] }),
    ).toEqual({ ok: true, unchanged: true });
  });

  it("writes nothing when the proposal differs from the selection only in spacing", () => {
    // The same rule `humanVersionBody` files a save under: two bodies neither
    // the gate nor the history can tell apart are not a new version.
    const full = "Alpha one. Beta two.";
    expect(
      refine({ body: full, select: "Beta two.", proposal: "Beta  two.", rows: [full] }),
    ).toEqual({ ok: true, unchanged: true });
  });

  it("writes nothing when every surviving sentence survived, even though the text changed", () => {
    // A blank proposal over a whole sentence: the merge really does delete it,
    // and the two that remain are the old body's, standing where they stood. No
    // unit is the splice's work, so there is nothing for a fragment row to be
    // evidence ABOUT — and without this branch the plan comes back carrying an
    // empty `fragmentBody`, which is a version row with no body and degenerate
    // evidence to every reader of it.
    const full = "Alpha one. Beta two. Gamma three.";
    expect(refine({ body: full, select: "Beta two.", proposal: " ", rows: [full] })).toEqual({
      ok: true,
      unchanged: true,
    });
    // The change really was material — this fixture is not quietly the one
    // above, where the merged body is text `isSameText` cannot tell apart.
    expect(normalizeForComparison("Alpha one.   Gamma three.")).not.toBe(
      normalizeForComparison(full),
    );
  });
});

describe("planRefineAccept — laundering, decided by offsets", () => {
  const full = "Buy now. Ships free.";
  const bodyWithHumanPrefix = "Buy now. Note: Ships free.";

  it("refuses when the merged unit absorbs a human's prefix", () => {
    // `Note: ` is outside the replaced range and belongs to a sentence no model
    // wrote. Accepting would file `Note: Ships fast.` as the model's, and the
    // badge would read AI-drafted over the person's own opening.
    expect(
      refine({
        body: bodyWithHumanPrefix,
        select: "Ships free.",
        proposal: "Ships fast.",
        rows: [full],
      }),
    ).toEqual({ ok: false, reason: "would_launder" });
  });

  it("accepts the same refine when the selection covers the whole human sentence", () => {
    // Same body, same model output, same intent — only the selection differs,
    // so the refusal above is about absorption and not about the sentence
    // having been a person's. Nothing of theirs survives into the merged unit.
    const plan = accepted(
      refine({
        body: bodyWithHumanPrefix,
        select: "Note: Ships free.",
        proposal: "Ships fast.",
        rows: [full],
      }),
    );
    expect(plan.mergedBody).toBe("Buy now. Ships fast.");
    expect(plan.fragmentBody).toBe("Ships fast.");
  });

  it("accepts a fragment that fuses with the AI sentence after it", () => {
    // Limit (a) from `allSentencesAi`'s docstring, closed here. "Make this hook
    // punchier" is exactly the verb that returns text with no terminator, so
    // the merged unit is `Punchier hook Gamma three.` — a string in no version
    // row. The row stores the unit as the SPLIT produced it, so the mask comes
    // out all-true instead of reading the model's own paragraph as a human's.
    const draft = "Alpha one. Beta two. Gamma three.";
    const plan = accepted(
      refine({ body: draft, select: "Beta two.", proposal: "Punchier hook", rows: [draft] }),
    );
    expect(plan.mergedBody).toBe("Alpha one. Punchier hook Gamma three.");
    expect(plan.fragmentBody).toBe("Punchier hook Gamma three.");
    expect(plan.unitDelta).toBe(-1);
    expect(aiSentenceMaskAny(plan.mergedBody, [draft, plan.fragmentBody])).toEqual([true, true]);
    expect(splitSentences(plan.mergedBody).length).toBeGreaterThanOrEqual(
      splitSentences(draft).length + plan.unitDelta,
    );
  });

  it("accepts a human line that merely happens to be a textual prefix of the proposal", () => {
    // The other half of §6's complaint about containment: `Bring a friend.` is
    // a person's line three sentences away, and it is a prefix of what the
    // model returned. A containment test fires here and throws away a call
    // somebody paid for. Offsets do not, because the line is nowhere near the
    // range — and the mask still reads it as theirs.
    const draft = "Grand opening.\nSee you there.";
    const body = "Grand opening.\nSee you there.\nBring a friend.";
    const plan = accepted(
      refine({
        body,
        select: "See you there.",
        proposal: "Bring a friend and a coffee.",
        rows: [draft],
      }),
    );
    expect(plan.fragmentBody).toBe("Bring a friend and a coffee.");
    expect(aiSentenceMaskAny(plan.mergedBody, [draft, plan.fragmentBody])).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("refuses when the fragment's count would light a human's own duplicate", () => {
    // The shape no containment test could ever see, and the reason the count
    // rule needs a guard of its own: the model returns a sentence the person
    // has already written elsewhere. Handing the key its full merged count is
    // what the mask needs for the spliced copy — and it lights theirs too.
    const draft = "Alpha one. Beta two. Gamma three.";
    const body = "Alpha one. Handmade line. Gamma three.";
    expect(
      refine({ body, select: "Gamma three.", proposal: "Handmade line.", rows: [draft] }),
    ).toEqual({ ok: false, reason: "would_launder" });
  });

  it("accepts the same splice when the proposal is not the person's sentence", () => {
    // One character of difference between this fixture and the one above, and
    // it is the property under test: their line stays theirs.
    const draft = "Alpha one. Beta two. Gamma three.";
    const body = "Alpha one. Handmade line. Gamma three.";
    const plan = accepted(
      refine({ body, select: "Gamma three.", proposal: "Different line.", rows: [draft] }),
    );
    expect(plan.fragmentBody).toBe("Different line.");
    expect(aiSentenceMaskAny(plan.mergedBody, [draft, plan.fragmentBody])).toEqual([
      true,
      false,
      true,
    ]);
  });

  it("lets a reshaped list marker follow its own attributability, both ways", () => {
    // Limit (b). `1. ` belonged to the old unit and `Get bread.` to the
    // fragment, so the merged unit `1. Get bread.` is in neither row. Whether
    // that is honest depends entirely on who wrote the line the marker came
    // from, and the two fixtures below differ in exactly that.
    const aiList = "Steps:\n1. Buy bread.\n2. Sell it.";
    const plan = accepted(
      refine({ body: aiList, select: "Buy bread.", proposal: "Get bread. Fast.", rows: [aiList] }),
    );
    expect(plan.mergedBody).toBe("Steps:\n1. Get bread. Fast.\n2. Sell it.");
    expect(splitSentences(plan.fragmentBody)).toEqual(["1. Get bread.", "Fast."]);
    expect(plan.unitDelta).toBe(1);
    expect(aiSentenceMaskAny(plan.mergedBody, [aiList, plan.fragmentBody]).every(Boolean)).toBe(
      true,
    );

    // The same splice where the person, not the model, numbered the line.
    const aiDraft = "Steps:\nBuy bread.\n2. Sell it.";
    const humanList = "Steps:\n1. Buy bread.\n2. Sell it.";
    expect(
      refine({
        body: humanList,
        select: "Buy bread.",
        proposal: "Get bread. Fast.",
        rows: [aiDraft],
      }),
    ).toEqual({ ok: false, reason: "would_launder" });
  });

  it("refuses when the merged unit keeps so much as the terminator of their sentence", () => {
    // A selection that stops one character short of the full stop, which is
    // what a drag-select routinely does. The `.` is outside the range, it came
    // from a sentence the person wrote, and it is the LAST character of that
    // sentence's span — the one place an overlap test that is loose by a
    // character stops looking. The merge is refused for the same reason the
    // `Note: ` one is; the recovery is to select the sentence, punctuation and
    // all.
    const draft = "Alpha one. Beta two.";
    const body = "Alpha one. Human line.";
    expect(refine({ body, select: "Human line", proposal: "Model line", rows: [draft] })).toEqual({
      ok: false,
      reason: "would_launder",
    });
    // Selecting the whole sentence, one character more, is accepted.
    const plan = accepted(
      refine({ body, select: "Human line.", proposal: "Model line.", rows: [draft] }),
    );
    expect(plan.fragmentBody).toBe("Model line.");
  });

  it("adds up two rows' credit for a key as the LARGEST of them, not the sum", () => {
    // The level has two rows — an original draft and an earlier accepted
    // fragment — each holding `CTA now.` once, and the person has typed a third
    // copy of it themselves. The masks are OR-ed and each consumes its OWN
    // multiset from the top, so two rows with one copy each still only ever
    // light the FIRST occurrence: their copy is theirs, and a fragment carrying
    // three copies would light all three. Summing the rows' counts makes the
    // guard read 2 and wave it through.
    const rows = ["Intro line. CTA now.", "CTA now."];
    const body = "Intro line. CTA now. CTA now.";
    expect(aiSentenceMaskAny(body, rows)).toEqual([true, true, false]);
    expect(refine({ body, select: "Intro line.", proposal: "CTA now.", rows })).toEqual({
      ok: false,
      reason: "would_launder",
    });

    // The same two rows and the same splice over a body with no copy of theirs
    // in it: accepted, so the refusal above is about the person's duplicate and
    // not about the level having two rows.
    const plan = accepted(
      refine({ body: "Intro line. CTA now.", select: "Intro line.", proposal: "CTA now.", rows }),
    );
    expect(splitSentences(plan.fragmentBody)).toEqual(["CTA now.", "CTA now."]);
    expect(aiSentenceMaskAny(plan.mergedBody, [...rows, plan.fragmentBody])).toEqual([true, true]);
  });

  it("does not read a separator as authorship", () => {
    // An unterminated proposal replacing a person's sentence fuses with the
    // MODEL's next one, so the merged unit reaches past the range — and the
    // first character it reaches is the space that belonged to the sentence
    // just replaced, which was theirs. Counting blank characters as absorbed
    // text refuses this merge, and nothing of theirs is in it: `Punchy hook`
    // is the model's and so is `Alpha one.`. The only difference between this
    // fixture and the `Note: ` refusal is whether what got absorbed was a word.
    const draft = "Beta two. Alpha one.";
    const body = "Handmade line. Alpha one.";
    const plan = accepted(
      refine({ body, select: "Handmade line.", proposal: "Punchy hook", rows: [draft] }),
    );
    expect(plan.mergedBody).toBe("Punchy hook Alpha one.");
    expect(plan.fragmentBody).toBe("Punchy hook Alpha one.");
    expect(aiSentenceMaskAny(plan.mergedBody, [draft, plan.fragmentBody])).toEqual([true]);
  });
});

describe("planRefineAccept — the delta and the bound", () => {
  const full = "Alpha one. Beta two. Gamma three.";

  it("measures the delta rather than inferring it", () => {
    for (const [select, proposal, delta] of [
      // The flagship verb doing its job: two sentences shortened into one.
      ["Alpha one. Beta two.", "Tight line.", -1],
      ["Beta two.", "Rewritten line.", 0],
      ["Beta two.", "Rewritten line. And more.", 1],
    ] as const) {
      const plan = accepted(refine({ body: full, select, proposal, rows: [full] }));
      expect(plan.unitDelta).toBe(delta);
      expect(splitSentences(plan.mergedBody).length - splitSentences(full).length).toBe(delta);
    }
  });

  it("refuses a merged body one character past the limit, and accepts it at the limit", () => {
    const filler = "z".repeat(MAX_BODY_LENGTH - 20);
    const body = `Alpha one. ${filler}.`;
    expect(body).toHaveLength(MAX_BODY_LENGTH - 8);
    const at = accepted(
      refine({ body, select: "Alpha one.", proposal: "B".repeat(18), rows: [body] }),
    );
    expect(at.mergedBody).toHaveLength(MAX_BODY_LENGTH);
    expect(refine({ body, select: "Alpha one.", proposal: "B".repeat(19), rows: [body] })).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  it("bounds the body the DTO would store, not the one the model returned", () => {
    // Normalise first, bound second — the body DTO's own rule. A proposal whose
    // CRLFs collapse to fit must not be refused for characters the product is
    // about to drop, and a merged body carrying a CR would slide the lens's
    // overlay off every word after it.
    const filler = "z".repeat(MAX_BODY_LENGTH - 20);
    const body = `Alpha one. ${filler}.`;
    const plan = accepted(
      refine({ body, select: "Alpha one.", proposal: `${"B".repeat(17)}\r\n`, rows: [body] }),
    );
    expect(plan.mergedBody).toHaveLength(MAX_BODY_LENGTH);
    expect(plan.mergedBody).not.toContain("\r");
    // And the offsets were measured against the collapsed proposal, not the
    // one that arrived. Leaving the CR in makes the replaced region one
    // character too long, the sentence after it stops mapping onto the one it
    // came from, and the row swallows the whole rest of the body — 4079
    // characters of it here.
    expect(plan.fragmentBody).toBe("B".repeat(17));
  });

  it("reports the laundering before the length when a merge is both", () => {
    // The order the union declares. Whether the product may say a model wrote
    // this is the more useful thing to be told.
    const filler = "z".repeat(MAX_BODY_LENGTH - 20);
    const draft = `Alpha one. ${filler}.`;
    const body = `Note: Alpha one. ${filler}.`;
    expect(refine({ body, select: "Alpha one.", proposal: "B".repeat(30), rows: [draft] })).toEqual(
      { ok: false, reason: "would_launder" },
    );
  });
});

describe("planRefineAccept — a range that cannot have come from a selection", () => {
  const body = "Alpha one. Beta two.";
  const aiRows = [{ body }];

  it("throws rather than dressing a caller's bug as a refusal", () => {
    for (const [start, end] of [
      [-1, 5],
      [5, 4],
      [0, body.length + 1],
      [1.5, 5],
      [0, Number.NaN],
    ]) {
      expect(() =>
        planRefineAccept({
          body,
          start: start as number,
          end: end as number,
          proposal: "X.",
          aiRows,
        }),
      ).toThrow(RangeError);
    }
  });

  it("accepts an empty range at the very end of the body", () => {
    const plan = accepted(
      planRefineAccept({
        body,
        start: body.length,
        end: body.length,
        proposal: " Gamma three.",
        aiRows,
      }),
    );
    expect(plan.mergedBody).toBe("Alpha one. Beta two. Gamma three.");
    expect(plan.fragmentBody).toBe("Gamma three.");
    expect(plan.unitDelta).toBe(1);
  });
});

/**
 * THE SWEEP. The increment's whole claim is a pair of properties, and a handful
 * of examples cannot hold it — the three limits this module closes were found
 * by enumerating an input matrix, not by picking cases.
 *
 * Precondition, stated because every assertion depends on it: the body IS the
 * model's `full` row, so before the splice every unit is attributable and the
 * count is exactly the reference's. That is the shape the flagship path has.
 */
describe("planRefineAccept — swept over generated merges", () => {
  const bodies = [
    "Alpha one. Beta two. Gamma three.",
    "Alpha one.\nBeta two.\nGamma three.",
    "Hook line\nBody line\nTail line",
    "Steps:\n1. Buy bread.\n2. Sell it.",
    "Repeat me. Repeat me. Then stop.",
    "今天很好。明天更好。后天最好。",
    "**Big news.** We ship today. Come see!🔥",
    "Only one sentence here.",
    "A. B. C. D. E. F. G. H.",
  ];
  const proposals = [
    "Short.",
    "No terminator",
    "One. Two.",
    "One.\nTwo.",
    "Repeat me.",
    "1. Marked line.",
    "早上好。",
    "A much longer replacement sentence that keeps going for a while.",
    "!🔥",
  ];

  it("reads a body into exactly the sentences splitSentences yields", () => {
    // The hinge the module's offset reasoning hangs on: trimming a span
    // character by character with this project's blank class has to land on the
    // same string `splitSentences` produces, or "the unit at offset N" and "the
    // unit the mask matched" stop being the same thing and every conclusion
    // below is about two different lists.
    for (const text of [...bodies, ...proposals, "  ", "\n\nLead blank.\nAnd more."]) {
      expect(unitSpans(text).map((unit) => unit.text)).toEqual(splitSentences(text));
    }
  });

  it("leaves every unit attributable and the count clause satisfied", () => {
    let planned = 0;
    let unchanged = 0;
    let refused = 0;
    const notAttributable: string[] = [];
    const countClauseBroken: string[] = [];
    const inventedText: string[] = [];
    const notASplice: string[] = [];
    const deltaDisagreed: string[] = [];

    for (const body of bodies) {
      const rows = [body];
      // Every unit boundary, plus a mid-unit offset inside each one.
      const offsets = new Set<number>([0, body.length]);
      for (const unit of unitSpans(body)) {
        offsets.add(unit.start);
        offsets.add(unit.end);
        offsets.add(unit.start + Math.floor((unit.end - unit.start) / 2));
      }
      const sorted = [...offsets].sort((a, b) => a - b);
      for (const start of sorted) {
        for (const end of sorted) {
          if (end < start) continue;
          for (const proposal of proposals) {
            const plan = planRefineAccept({
              body,
              start,
              end,
              proposal,
              aiRows: rows.map((rowBody) => ({ body: rowBody })),
            });
            const where = `${JSON.stringify(body)} [${start},${end}) <- ${JSON.stringify(proposal)}`;
            if (!plan.ok) {
              refused++;
              continue;
            }
            if ("unchanged" in plan) {
              unchanged++;
              continue;
            }
            planned++;

            // 1. The merged body is the splice and nothing else.
            if (plan.mergedBody !== body.slice(0, start) + proposal + body.slice(end)) {
              notASplice.push(where);
            }
            // 2. Every unit of it is the model's, once the fragment is evidence.
            const evidence = [...rows, plan.fragmentBody];
            if (!aiSentenceMaskAny(plan.mergedBody, evidence).every(Boolean)) {
              notAttributable.push(where);
            }
            // 3. The gate's deletion clause, as this delta makes it read. The
            //    body is the first `full` row, so the running sum is this one
            //    delta; `>=` is the clause, and equality is what it should be.
            const merged = splitSentences(plan.mergedBody).length;
            if (merged < splitSentences(body).length + plan.unitDelta) {
              countClauseBroken.push(where);
            }
            if (merged - splitSentences(body).length !== plan.unitDelta) {
              deltaDisagreed.push(where);
            }
            // 4. The row holds units of the merged body, never text of its own.
            const mergedUnits = splitSentences(plan.mergedBody);
            for (const piece of splitSentences(plan.fragmentBody)) {
              if (!mergedUnits.includes(piece)) inventedText.push(`${where} :: ${piece}`);
            }
          }
        }
      }
    }

    expect(notASplice).toEqual([]);
    expect(notAttributable).toEqual([]);
    expect(countClauseBroken).toEqual([]);
    expect(deltaDisagreed).toEqual([]);
    expect(inventedText).toEqual([]);
    // A corpus that stopped producing plans would leave all of the above green
    // and empty, so the shape of what it produced is asserted too.
    expect(planned).toBeGreaterThan(1000);
    expect(unchanged).toBeGreaterThan(0);
    // And a property in its own right: a body that is entirely the model's has
    // nothing to launder, so every refusal here would be a paid call thrown
    // away. It holds because a surviving sentence is one of the row's own, so
    // the untouched occurrences of any key can never outnumber the row's.
    expect(refused).toBe(0);
  });

  it("keeps the delta equal to what the splice introduced minus what it removed", () => {
    // The cross-check §6 asks for, with both halves derived here rather than
    // read off the plan: a merged unit SURVIVED when mapping its extent back
    // through the splice lands on a pre-merge unit exactly, and everything else
    // is the splice's work. The offset arithmetic is what is really on trial —
    // get the shift wrong by one and no unit maps onto anything, every merge
    // reads as a total rewrite, and this goes red.
    let checked = 0;
    let survivorsSeen = 0;
    const collided: string[] = [];
    const disagreed: string[] = [];
    for (const body of bodies) {
      const pre = unitSpans(body);
      const extents = new Map(pre.map((unit, index) => [`${unit.start}:${unit.end}`, index]));
      for (const unit of pre) {
        for (const proposal of proposals) {
          const { start, end } = unit;
          const plan = planRefineAccept({ body, start, end, proposal, aiRows: [{ body }] });
          if (!plan.ok || "unchanged" in plan) continue;
          checked++;
          const where = `${JSON.stringify(body)} [${start},${end}) <- ${JSON.stringify(proposal)}`;
          const rangeEnd = start + proposal.length;
          const back = (offset: number): number =>
            offset < start ? offset : offset - rangeEnd + end;
          const survivors = new Set<number>();
          let introduced = 0;
          for (const merged of unitSpans(plan.mergedBody)) {
            const index = extents.get(`${back(merged.start)}:${back(merged.end - 1) + 1}`);
            if (merged.start < rangeEnd && merged.end > start) {
              introduced++;
            } else if (index === undefined) {
              introduced++;
            } else {
              if (survivors.has(index)) collided.push(where);
              survivors.add(index);
            }
          }
          survivorsSeen += survivors.size;
          if (plan.unitDelta !== introduced - (pre.length - survivors.size)) disagreed.push(where);
        }
      }
    }
    expect(collided).toEqual([]);
    expect(disagreed).toEqual([]);
    expect(checked).toBeGreaterThan(100);
    // Without this the arithmetic could be checked entirely on merges where
    // nothing survived, which is where a broken mapping hides.
    expect(survivorsSeen).toBeGreaterThan(100);
  });

  it("never carries a person's own sentence into the model's evidence", () => {
    // The other precondition: a body with exactly one human sentence in it. No
    // proposal reproduces that sentence, so any merged unit still equal to it
    // is the person's, standing where they left it — and it must still read as
    // theirs after the fragment is filed.
    const human = "Handmade line here.";
    const humanKey = normalizeForComparison(human);
    let survived = 0;
    let refused = 0;
    const laundered: string[] = [];
    for (const draft of bodies) {
      const draftUnits = splitSentences(draft);
      if (draftUnits.length < 2) continue;
      const body = [draftUnits[0], human, ...draftUnits.slice(1)].join("\n");
      const rows = [draft];
      for (const unit of unitSpans(body)) {
        // Whole-sentence ranges AND a range starting inside one: refining part
        // of a sentence is what makes the merged unit keep somebody else's
        // words, and it is the only way the absorption guard is ever reached.
        const starts = [unit.start, unit.start + Math.floor((unit.end - unit.start) / 2)];
        // The model handing back a line the person wrote elsewhere is the only
        // way the count guard is reached, so the corpus has to contain it.
        for (const proposal of [...proposals, human]) {
          for (const start of starts) {
            const plan = planRefineAccept({
              body,
              start,
              end: unit.end,
              proposal,
              aiRows: rows.map((rowBody) => ({ body: rowBody })),
            });
            if (!plan.ok) {
              expect(plan.reason).toBe("would_launder");
              refused++;
              continue;
            }
            if ("unchanged" in plan) continue;
            const units = splitSentences(plan.mergedBody);
            const mask = aiSentenceMaskAny(plan.mergedBody, [...rows, plan.fragmentBody]);
            units.forEach((text, index) => {
              // The splice can also PRODUCE this sentence — that is the count
              // guard's case and it is refused above, so anything reaching here
              // and reading as the person's line is the one they wrote.
              if (normalizeForComparison(text) !== humanKey) return;
              survived++;
              if (mask[index]) {
                laundered.push(
                  `${JSON.stringify(body)} [${start},${unit.end}) <- ${JSON.stringify(proposal)}`,
                );
              }
            });
          }
        }
      }
    }
    expect(laundered).toEqual([]);
    // Both halves have to happen for the sweep to mean anything: the sentence
    // has to survive some merges, and the guard has to fire on others.
    expect(survived).toBeGreaterThan(100);
    expect(refused).toBeGreaterThan(0);
  });
});
