# Pubrick — Authorship, Per Sentence (Design)

**Date:** 2026-08-29
**Status:** Historical record of a decision the codebase still lives with —
not living documentation. Increment 2b-1 shipped; where this document and
the code disagree, the code is right. §7's forward-looking content has been
replaced with a pointer — see the note there.
**Covers:** increment **2b-1** — teaching the publish gate and the origin badge
to reason about authorship one sentence at a time, so that when refine verbs
arrive they cannot open the promise. Server only: a migration, two formula
changes, human version rows. No model call, no new spend, no new UI.

**Provenance:** Copied (front matter adapted, §7 replaced with a pointer;
body otherwise verbatim) from the project's private planning repository on
2026-09-04.

**Why this ships before the feature.** Refine verbs break the current gate: one
accepted proposal and the body equals no stored version, so the gate concludes a
human touched it and lets an unread draft through — to exactly the callers it
was written for, the public API, the MCP server, a script. Shipping the verbs
first means shipping that hole and closing it afterwards. Shipping this first
means the hole never exists. It is also provably safe on its own: with no refine there are no fragment rows,
and with a single `full` row the new formula reproduces the old comparison
exactly — checked exhaustively over two thousand pairs, where the only
disagreements are an empty or whitespace-only body and a level whose sole
evidence is a fragment, both of which the new formula refuses and the old one
allowed.

§7 records what 2b-2 (the verbs themselves) must answer, including several
things this review established.

---

## 1. What actually breaks, stated correctly

An earlier draft of this document justified the redesign with two claims about
the current code that are **false**, and they are corrected here because a
reviewer will check them:

- A fragment version row cannot flip the gate. The gate reads the **first**
  `ai` row per level, so a fragment appended later is never the reference.
- A fragment cannot flip the badge either. `matchesAnyAiVersion` is a `some`, so
  adding a row can only turn `false` into `true`.

What breaks both is **the merged body an accepted refine produces**. It equals no
stored row, so the gate reads a human touch that never happened, and the badge
reads "human-edited" on the model's own words. The fragment is not the hazard;
it is the evidence that makes the correct answer computable.

## 2. The question changes

From "is the body equal to something the model wrote" to "is **every sentence**
of it something the model wrote".

```
allSentencesAi(current, aiRows, firstFullRow) =
  aiRows.length === 0                                     // no evidence: refuse
  || (splitSentences(current).length > 0
      && aiSentenceMaskAny(current, aiRows).every(Boolean)  // nothing new is human
      && nothingDeleted(current, firstFullRow))             // and nothing was removed
```

`aiSentenceMaskAny` is the function the lens already uses; this reads it at a
coarser grain. So the gate and the lens stop being two stories — "refuse while
every sentence is still the model's" is the same fact the editor paints.

**The badge asks the same question and takes the same formula.** This is not
optional and the earlier draft's omission of it was the review's first finding:
`bodyIsAiVerbatim` in both `list()` and `get()` becomes `allSentencesAi`,
replacing `matchesAnyAiVersion`, which then has no caller and is deleted.
Leaving the badge on whole-body equality would render "Human-edited" on a
refined draft that is 100% the model's — the exact inversion this increment
exists to prevent, on the surface the user actually looks at.

So there are now **two references, not three**: one question — is every sentence
the model's — answered for the whole text (gate, badge) and per sentence (lens).
Three places currently state the three-reference rule and all three must be
rewritten: `CLAUDE.md`, `provenance.ts`'s docstring table, and
`apps/web/src/lib/origin.ts`.

This supersedes the provenance-lens spec's §11, which prescribed
`rows.some(r => isUntouchedAi(current, r))` for the gate. That does not close the
hole: a fragment can never satisfy a whole-body equality against a longer body,
so it contributes nothing, and the refined body still matches no row.

## 3. Deletion must stay a human act

The old comparison short-circuited on a sentence-count mismatch, deliberately:
"a deletion is a human act even though nothing new appeared". A mask has no
count, so without care a body that is a strict subset of the model's sentences
would read "all AI" — and trimming an over-long draft, the commonest API-side
edit there is, would start being refused with a message that tells the caller to
edit it, which they just did.

Hence the third clause — and its first formulation was wrong in a way worth
recording, because it would have made the increment close nothing. "Every
sentence of the first `full` row must still appear in the text" is a
**membership** test, and a refine *replaces* one of those sentences: every
accepted proposal would read as a deletion, and the gate would open on exactly
the case this exists to refuse.

The clause is therefore a **count**: the text must have at least as many
sentences as the level's first `scope = 'full'` `ai` row. Given clause 2 —
every sentence present is the model's — that asks the same question and lets
refines through. Skipped when there is no full row. This is also what gives
`scope` a reader in this increment rather than a column nothing exercises.

**Three holes stay open, and they belong to 2b-2**, because closing them needs
the proposal to record what it replaced — a staging-loop concern:

- A refine that replaces two sentences with one is indistinguishable from a
  deletion by count.
- **The partition of the merged body is not the union of the rows' partitions.**
  A proposal that comes back without a terminator — which is what "make this
  hook punchier" returns — fuses with the sentence after it, and the fused unit
  matches no row. Measured: 4 of 72 pure refines, no human touch anywhere.
- The same happens when the merged unit carries a list marker the selection
  excluded.

All three run the unsafe way: a draft that is entirely the model's reads as
touched, so the gate opens and the badge captions the model's words as the
human's. 2b-2 closes them by re-splitting at Accept and requiring every new unit
to be attributable; until then the limit is stated in the code rather than
implied by a comfortable docstring.

**One property is worth stating as a theorem, because it is stronger than a
sample.** With a single `full` row and no fragments — every row on live data —
the new formula cannot disagree with the old one in the unsafe direction. If the
text has sentences and the formula is true, the mask is all-true and the count is
at least the reference's; a multiset match then forces the counts equal by
pigeonhole, which is exactly what the old comparison called untouched. So
`new = false ∧ old = true` is unsatisfiable, and every disagreement is an empty
body. A 1.48-million-pair sweep found precisely that and nothing else.

**Partial evidence refuses, like no evidence.** Zero rows refuse; only `human`
rows refuse; and — the shape this increment makes reachable — a level with only
`fragment` rows and no `full` row is missing its evidence and refuses too.

## 4. The schema

Migration `0006`, additive:

- `content_versions.scope` — `full | fragment`, default `full`, so every
  existing row keeps its meaning. Only whole bodies can be restored or listed as
  history (2c), and only whole bodies answer §3's deletion clause.
- `usage_ledger.content_item_id` and `adaptation_id` — nullable,
  `ON DELETE SET NULL`, the table's existing convention because money outlives
  what it was spent on. 2b-2's refine calls have no run, so without these
  nothing can answer what refining a draft cost. Whether a refine can target an
  adaptation is 2b-2's decision (§7); the column is added now because the
  migration is open, and an unused nullable column is cheaper than a second
  migration.

## 5. The gate's entry widens

Today the gate is entered on the **item's** origin, so a human-written item
carrying AI adaptations skips every check — and 2b-2's verbs on a hand-typed
draft produce exactly that shape. The code already names the fix; this takes it:
enter whenever an `ai` version row exists for the item **or any adaptation**.

**Say the cost precisely, because it is worse than "refused until opened".** For
a hand-typed item with one AI adaptation there are no item-level `ai` rows, so
the body's clause takes the missing-evidence branch and is true *permanently* —
human version rows are invisible to a question filtered to `origin = 'ai'`. The
caller can rewrite every word and still be refused; only opening it clears the
gate. Either the refusal message names that case, or an item-level `human` row
counts as evidence of a touch. **Decision: the message names it.** Making human
rows evidence would mean the gate reading rows it filters out everywhere else,
and the one-click recovery (open it) is the same recovery the promise already
asks for.

## 6. Human version rows

A human save writes a `full` row with `origin = 'human'` and `created_by`, so
2c has a history and something to restore to. Three constraints the code
imposes:

- A row is written **only when the body actually changed** under
  `normalizeForComparison`. A title-only PATCH writes none; `content_versions.body`
  is `NOT NULL`, so a cleared override writes none either. This governs
  `updateAdaptation` as well as `update` — the adaptation level was silent in
  the earlier draft.
- The `origin = 'ai'` filter stays everywhere the gate and badge read. An e2e
  already pins that a `human` row ordered first must not become the reference.
- `created_by` needs a `@UserId()` decorator beside `@OrgId()`, reading the
  session the global auth guard attaches and throwing on an unguarded route
  exactly as `@OrgId()` does, rather than returning `undefined`.

## 7. What 2b-2 must answer

*(2026-09-04 note: this section originally recorded a long list of
open questions and sequencing notes for the next increment — provider
resolution, a concurrency lease, timeout handling, the anchor rule, and
where the refine verbs live on screen. Roughly half of those premises were
already found false by the time the next spec (`0006`,
"the API can call a model") and the increment after it were written — for
example, `defineStep` and `Material` are no longer unexported, and
`callStep` now forwards the full argument set this section said it dropped.
Carrying a list of "must answer" questions forward once some of the
questions have been answered, and some of the premises they were asked
against have changed, documents a discussion rather than a decision.
Sequencing notes for unimplemented or partially-implemented work are being
kept out of this directory going forward — see the project's issue tracker
for what remains open in this area, and `0006` for the parts of this
section it directly superseded.)*

## 8. Testing

Every gate case currently pinned must still pass — all twelve of them do under
this formula, which is why §3's deletion clause needs its own new test rather
than relying on the suite to notice. Add: a refined body (a full row plus a
fragment) still refused; one human sentence opening the gate; a deletion allowed;
a level with only fragment rows refused; the widened entry refusing a hand-typed
item with an AI adaptation until opened; the badge reading AI-drafted for a
refined body; a human save writing exactly one `full` row, and an unchanged save
writing none.

One existing e2e is named "compares against the FIRST ai version" and keeps
passing while its name becomes a lie; it is renamed and its comment rewritten in
the same commit that changes the formula.

## 9. Out of scope

The verbs, the staging loop, `⌘K`, the timeout, the concurrency bound, provider
resolution (all 2b-2). Re-adaptation, version history and Restore (2c). Rich
formatting, images, sources. And two increment-1 deferrals still unscheduled,
named so they stay visible: the per-run cost endpoint and the `awaiting_review`
run status.
