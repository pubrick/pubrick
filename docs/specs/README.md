# Design specs

Numbered decision records, in the order the product was built. Each one is a
**historical record of a decision the codebase still lives with** — not
living documentation. Comments in the code cite them as "the design" or "the
spec"; use this index to find the right file, since several of them share
section numbers.

| # | Document | Covers | Cited in code as |
|---|---|---|---|
| [0001](0001-product-design.md) | Product design | Positioning, stack, phasing | "the product design" |
| [0002](0002-design-system.md) | Design system & UX constitution | Tokens, shell, the five UX-constitution rules | "the design-system spec/design" |
| [0003](0003-ai-generation-engine.md) | AI generation engine | Increment 1 — BYOK credentials, the run state machine, the five-role chain, cost accounting, provenance's first cut | "the generation-engine spec" |
| [0004](0004-provenance-lens.md) | The provenance lens | Increment 2a — the sentence-dimming editor overlay, the splitter, the per-channel counter | "the provenance-lens design/spec" |
| [0005](0005-authorship-per-sentence.md) | Authorship, per sentence | Increment 2b-1 — the publish gate and origin badge reasoning per sentence, ahead of the refine verbs | "the authorship-per-sentence spec/design" |
| [0006](0006-api-can-call-a-model.md) | The API can call a model | Increment 2b-2a — provider resolution, cancellation and abort accounting for an editor-side model call | not yet cited by name in code comments as of this copy |
| [0007](0007-partial-delivery-design.md) | Partial delivery: what a half-sent post is | Issue #16 — what an item whose channels disagree IS, the `unknown` refusal and its human resolver, `nextItemStatus` as the one promotion rule | shipped; cited by section number (§4.2, §4.3, §4.4) in the content repository and the item screen |

`0007` has shipped WITH THE THREE DEVIATIONS BELOW: the `unknown` refusal and
its resolver, the `partially_published` status with its migration and backfill,
the reject gate, and the item screen's labels, gates and disclosure are all in
the code. Three of its decisions were changed by review while landing, and the
CODE is the answer on all three:

1. **Reject cancels rather than refuses.** On a fan-out with a delivery still
   outstanding, reject CANCELS that delivery and leaves the item
   `partially_published`; it refuses (409) only once nothing is left to stop.
   §4.2 wrote only the refusal, which would have taken away the one
   send-stopper the product has.
2. **"Publish now" counts `pending` as well as `failed`.** The label counts
   every channel `approve` will target minus the `unknown` rows it skips, which
   on the post reject just made is a `pending` row and no failures at all. §4.4
   predates that state. `scheduled` is in `approve`'s set and deliberately NOT
   in the count: no writer can leave a `scheduled` row on a
   `partially_published` item, and "did not go out" would be false of one.
3. **The queue does not hoist `partially_published`, and does not flag it.**
   §4.1 asked for both. The order stays the lifecycle one — Failed · Drafts ·
   Approved · Partly published · Rejected · Published — because the head is
   "failures first" and a half-successful post is not a failure; and the red
   flag with its one-click "Try again" is exactly the press this product
   refuses over a fan-out that may hold an `unknown` row.

Its front matter still says DECIDED, not implemented.

Each document's own front matter says what shipped and, where later work
changed the schema or the code it describes, an inline editorial note says
so. If a document and the running code disagree on anything not already
flagged, the code is right — open an issue rather than trusting the prose.

Two of these documents (`0004` and `0005`) originally carried a section
recording open questions for the *next* increment. Those sections have been
replaced with a short pointer: sequencing notes for unimplemented work don't
belong in a shipped repository's decision record, and in both cases later
work had already found some of the original questions' premises false by the
time this copy was made. See each file's own note for specifics.
