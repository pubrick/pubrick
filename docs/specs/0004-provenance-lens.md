# Pubrick — The Provenance Lens (Design)

**Date:** 2026-08-29
**Status:** Historical record of a decision the codebase still lives with —
not living documentation. Increment 2a shipped; where this document and the
code disagree, the code is right. §11's forward-looking content has been
replaced with a pointer — see the note there.
**Covers:** increment **2a** — seeing which sentences are still the AI's, while
you edit. The first of three parts.

**Provenance:** Copied (front matter adapted, §11 replaced with a pointer;
body otherwise verbatim) from the project's private planning repository on
2026-09-04.

Increment 1 shipped the engine and the promise: nothing publishes that no human
opened and nothing touched. It shipped three of the four origin badges, and it
shipped `aiSentenceMask` — used by nobody, because no endpoint returns the text
to compare against. This increment turns that dead code into the product's
signature: open a draft, turn on the lens, and see exactly which sentences you
have not touched.

**Why this is its own increment.** The first draft of this document covered
refine verbs, `⌘K`, the staging loop, re-adaptation, version history and restore
as well. Review found eight critical defects across them — most in the money and
provenance decisions of the refine half — and made the case that eight decisions
needing eight review passes should not share one. Splitting also puts the
shippable half first: the lens needs no migration, no new spend, and no new
model call, and on its own it finishes a claim the product already makes.

**Research basis.** Verified 2026-08-29 against this repository and live
sources. One research pass described a *different* repository (atools'
`frontend/`, reporting happy-dom and an existing Tiptap dependency); both claims
were checked here and discarded — `apps/web` runs vitest 4 on **jsdom 30** with
no editor library.

---

## 1. The editing surface

A `<textarea>` renders one flat text node and cannot style a substring. The
surface is therefore a real `<textarea>` with a **mirrored overlay**: an
`aria-hidden` div behind a transparent textarea, rendering the same characters
with the still-AI ones dimmed.

**Why not a rich-text framework.** Tiptap or Slate buys a document model this
product does not want — bodies are plain text and formatting is out of scope —
at 59–126 KB gzipped. (Lexical is out on architecture regardless of size: it has
no decoration layer, so per-sentence dimming would mean splitting text nodes and
polluting undo.) The decisive objection is testability: driving a
`contenteditable` with `user-event` in jsdom types correctly at the end of the
text and **silently no-ops mid-text**. The central test of this feature — edit
sentence two, watch only sentence two un-dim — would pass while nothing
happened. Green and blind is the failure class this repo keeps finding.

With a textarea the browser owns caret, IME, dead keys, autocorrect, selection
handles and undo; we own only paint. It stays a labelled textarea with a working
`maxLength`, adds no dependency, and `user.type()` edits mid-text correctly in
jsdom.

**Isolate it behind one component.** Chrome 152 shipped `OpaqueRange` on
2026-08-25 — range-like APIs, including `getBoundingClientRect()`, over a form
control's *value*. Chrome-only, so it changes nothing today, but it is the API
that eventually deletes the mirror. Nothing else may depend on it. (The CSS
Custom Highlight API does not help: Baseline since 2025, still cannot target a
textarea, because a textarea's value is not in the DOM tree.)

## 2. The splitter must become lossless first

This is the correction the whole increment rests on. `splitSentences` **trims
every piece and consumes newlines without emitting them**, so it is not a
partition of its input:

```
splitSentences("Hello. World.\n\nSecond line here. Done.")
  → ["Hello.", "World.", "Second line here.", "Done."]
```

Joining those loses every inter-sentence space and both newlines. An overlay
built from them would render a different character stream than the textarea:
fewer lines, different wrap points, and dim highlights sliding off the words
they describe from the first line break onward. "Both layers wrap identically
by construction" is only true if the overlay renders the *same characters*.

So `@pubrick/shared` gains `splitSentenceSpans(text): { start, end }[]` — a
**gapless partition**, every character accounted for — and `splitSentences` is
re-expressed on top of it so the two cannot disagree. The overlay renders
`text.slice(start, end)` per span, separators included.

This reintroduces offsets, and the provenance module opens by refusing them
("offsets rot on the first edit"). The distinction is explicit and belongs in
the code: these offsets are **recomputed from the current text on every render
and never persisted**. What rots is a stored offset; a derived one is just a
loop index.

## 3. Three references, not one

Review found that increment 1's convenient phrase — one function, so the badge
and the gate cannot disagree — does not survive contact with multiple AI
versions. Each question needs its own reference, and each must be stated where
it is used:

| Question | Reference | Formula |
|---|---|---|
| May this be approved? (the gate) | the **first** `ai` row per level | unchanged in 2a |
| What does the badge say? | **any** `ai` row | `bodies.some(b => isUntouchedAi(body, b))` |
| Which sentences dim? | **all** `ai` rows | index-wise OR of `aiSentenceMask(current, b)` |

Two traps this table avoids. `isUntouchedAi` short-circuits when sentence counts
differ, so it can never be applied to concatenated versions — concatenation
always returns false. And `aiSentenceMask` consumes each AI sentence at most
once on purpose (two copies of a sentence the AI wrote once leave the second
marked human); concatenating references breaks that counting, dimming a human's
own duplicate. The mask over many versions is therefore a **new named helper**,
`aiSentenceMaskAny(current, aiVersions)`, that ORs per-version masks so each
version keeps its own multiset counting — with a test pinning the duplicate
case.

In 2a there is exactly one `ai` row per level, so all three answers coincide;
the helper exists now so that 2b's refine rows, which create the second row,
find a correct formula rather than inventing one.

## 4. What the API must return

`GET /api/content/:id` gains `aiVersionBodies`: the `ai` version bodies for the
item and for each adaptation. The mask is then computed **in the browser** with
the same `@pubrick/shared` functions the API uses — the web already depends on
that package.

A server-computed mask was rejected: the client would still have to split
identically to align flags to spans, and two splits that must agree is how they
stop agreeing.

**The badge is the other way round, and for the same reason.** It is not a mask
— it is one boolean, with nothing to align — so it is computed on the server
with `matchesAnyAiVersion` (`@pubrick/shared`, §3's middle row) and returned as
`bodyIsAiVerbatim` on the item response **and on every LIST row**. That is what
makes §5's "the badge already carries the claim at a glance on every card" true:
a queue card has no reference text and never will, and shipping every version
body to draw four words would be absurd. Verdicts are cheap; text is not.

The character normalisation this rests on: `contentCreateSchema`,
`contentUpdateSchema` and `adaptationUpdateSchema` pipe `body` through
`normalizeNewlines`, so no body reaches storage carrying CR. A `<textarea>`
strips CR from its API value while the React string the overlay slices does
not — so a stored CR is the one input that breaks the overlay's character
identity from *outside* the partition, and it also makes the counter report a
length the field does not hold. The boundary, not the component, is where this
is settled: the gate and the mask compare stored text, and both must see the
same characters. (`DimmedTextarea` normalises again on render, for text that
arrived before the rule.)

## 5. The lens

A toggle in the editor, off by default. On, still-AI sentences render dimmed;
everything else renders normally. The mask recomputes as you type — it is a pure
function of the current text and the reference bodies, with no state to keep in
sync.

**Off by default is a deliberate trade, and it is the owner's to revisit.** The
pattern dossier's §5.3 says AI text is *visibly* AI until a human touches it,
which argues for on. The same dossier's §2.3 says the writing surface stays
calm. This increment ships it off, because the badge already carries the claim
at a glance on every card and the lens is for when you want detail — but that
choice is written down here rather than buried in a default.

That argument is load-bearing, so it was made true rather than softened: the
LIST response carries `bodyIsAiVerbatim` (§4), and a rewritten item reads
**human-edited** on the card and on the screen it opens. It did not at first —
the card had no reference text, so it said "AI-drafted" and the item screen said
"Human-edited" one click later, which is a worse untruth than the one the lens
exists to remove.

**On screen, the lens says what dim means.** Turned on with nothing dimmed, the
lens has an unreadable success state: no way to tell "every sentence here is
yours" — the commonest case on a post that has been worked on — from "the
highlighting is broken". A one-line legend under the toggle, shown only while
the lens is on, is the answer to the question the toggle just raised.

**The badge gains its fourth value.** An `ai` item whose body matches no `ai`
version reads **human-edited**. Increment 1 shipped three of four only because
the version text never left the server.

## 6. The counter must stop lying

A channel's textarea shows `/ 4096` for every platform while the adapter enforces
280 for X and 300 for Bluesky. The counter shows `adaptationLimit(platform)` —
`min(platformLimit, MAX_BODY_LENGTH)`, the same function the adapter uses.

**The `maxLength` attribute does not drop with it.** An existing override longer
than the new denominator must stay editable; a hard cap below its length would
make it permanently unfixable, which is exactly what `adaptationLimit`'s own
docstring exists to prevent.

**Over-limit is shown, never enforced — and that is the decision.** An earlier
draft of this section said an over-limit override "is refused on save". It never
was: `adaptationUpdateSchema` bounds an override by `MAX_BODY_LENGTH` and by
nothing else, `ContentRepository.updateAdaptation` checks status and org and no
length at all, and there is no per-platform bound anywhere on the write path.
What the product does instead is show it — the counter reads `300 / 280` in the
danger colour — save it verbatim, and never truncate it. Three reasons that
stands rather than being closed with a save-time refusal:

- **A refusal in the browser is not one.** The same body still saves from a
  script, the MCP server, or the public API, so the UI would be advertising an
  enforcement the product does not have — the exact class of untruth this
  increment exists to remove.
- **It would trap work.** There is no autosave, so refusing over-limit text
  means a 900-character override cannot be saved at all until it is under 280 in
  one sitting. That is the "you can read it but never fix it" failure the
  `maxLength` paragraph above refuses, arriving by a slower road.
- **The bound belongs where every caller passes.** `telegramPublisher.publish`
  already refuses text outside `1..maxTextLength` with a permanent error, which
  is recorded on the adaptation and shown on the item screen. Telegram's limit
  *is* `MAX_BODY_LENGTH`, so no over-limit body can reach it today; the
  platforms where an over-limit override is possible at all — x, bluesky,
  mastodon, max — have no publisher yet, and each publisher, when written, is
  the one place that refusal has to live.

If a save-time bound is wanted later, it is an API change (the update path would
have to read the channel's platform), not a counter change, and it should arrive
with an answer for the trapped-work case above — an over-limit body a lowered
constant created must still be shortenable in more than one sitting.

## 7. Overlay correctness

Everything that must be mirrored, because getting one wrong misaligns the whole
paint: `font` shorthand and every `font-*`, `letter-spacing`, `word-spacing`,
`tab-size`, `text-transform`, `white-space: pre-wrap`, `overflow-wrap`, padding,
border width, and `direction`. `dir="auto"` is mirrored explicitly rather than
inherited, so an RTL first character flips both layers together.

Scroll is synced on the textarea's `scroll` event. A trailing newline needs a
zero-width character so the last line keeps its height. The overlay is
`pointer-events: none` and `aria-hidden`, so it can never take a click or reach
a screen reader — the textarea remains the only interactive, labelled control.

Three conditions the lens must stand aside for, rather than discover in the
wild. **Forced-colors mode**, where the transparent-text-plus-caret-color trick
paints the real text opaque and doubles it against the overlay — and where a
dim/normal distinction has no meaning anyway, because the UA picks the colours.
**Printing**, for the same reason. And **IME composition**: pre-edit text lives
in the textarea and not in our value, so under a transparent textarea it would
be invisible while the user types it — the lens steps back between
`compositionstart` and `compositionend`, which is the difference between
supporting Chinese and Japanese input and merely claiming to.

Two metrics found while building it that belong in the list above:
`scrollbar-gutter`, because a scrollbar narrows the textarea's content box and
moves its wrap points without moving the overlay's; and the placeholder colour,
which the UA derives from `color` — transparent text makes an explicit
placeholder colour load-bearing rather than cosmetic.

## 8. Testing

jsdom 30 has no layout engine: every rect is zero, nothing wraps, `scrollTop`
stays 0. So the tests pin what jsdom can actually prove, and the rest is checked
in a browser and marked as such.

**In jsdom:** the overlay's rendered `textContent` is **character-identical** to
the textarea's `value` — the assertion that fails today's lossy splitter, and
the one that catches a regression in `splitSentenceSpans`; the mask after a
mid-text edit (edit sentence two, only sentence two un-dims); the mask after an
edit that merges or splits a sentence; `aiSentenceMaskAny`'s duplicate-sentence
case; the badge's fourth value; the counter's denominator per platform, and that
`maxLength` did *not* drop; the lens defaulting off and toggling; an unsegmentable
language rendering as one span.

Also in jsdom, and wrongly excluded by the first version of this section:

- **Scroll sync.** jsdom generates no scroll offset of its own, but it stores a
  written `scrollTop` and reads it back — which is all the handler propagates.
  Write the offset, fire the event, assert the overlay followed; and the same
  for the sync that runs as the overlay attaches (turning the lens on halfway
  down a draft). What genuinely needs a browser is whether a synced offset lands
  the two layers on the same *pixel row*, which needs wrapping, which needs
  layout.
- **That `MIRRORED_METRICS` reaches both layers.** Comparing the two class
  strings *to each other* is the tautology below. Comparing each against the
  exported constant is a different assertion, and the higher-consequence one: a
  metric that reaches only one layer misaligns the whole paint, and nothing else
  in the suite can see it happen.
- **A CR in the corpus.** The identity assertion is only as good as its inputs,
  and CR is the one character a textarea silently removes. `\r`, `\r\n` and a
  trailing `\r` belong in it — as does the DTO's own normalisation test, since
  the component's belt would otherwise hide a boundary that stopped working.

**Asserting "same wrapping inputs" would be a tautology** — comparing the two
layers' class names *to each other* proves nothing without layout. Alignment and
forced-colors go in the browser bucket.

⚠ `apps/web` resolves `@pubrick/shared` from `dist`. A bare
`pnpm --filter @pubrick/web test` validates the previous build and would stay
green through a change to the splitter — the mask tests must run after a shared
build, or through the root `pnpm test`.

## 9. Corrections this increment makes to increment 1's spec

- Its §6 claims one function keeps the badge and the gate in agreement. With
  more than one `ai` version that is false; §3 above replaces it.
- Its §6 describes the mask as sentence-level rendering, which the lossy
  splitter cannot support; §2 above is the prerequisite it did not know it had.

## 10. Out of scope for 2a

Refine verbs, `⌘K`, the staging loop, re-adaptation, version history, restore,
human version rows, the `@UserId()` decorator, migration 0006. No new model
call, no new spend, no schema change.

## 11. What 2b and 2c must answer

*(2026-09-04 note: this section originally recorded sequencing notes and
open questions for the next two increments. One of its central claims — the
gate formula proposed below — was superseded before it shipped: the
authorship-per-sentence spec (`0005`) found that a whole-body-equality gate
over multiple `ai` rows still does not close the hole a refine opens, and
replaced it with a per-sentence formula instead. Carrying the original
prescription forward here would document a decision the code never made.
Sequencing notes for unimplemented work are being kept out of this directory
going forward — see the project's issue tracker for what remains open in
this area, including the per-run cost endpoint and the `awaiting_review` run
status, both still unscheduled as of this copy.)*
