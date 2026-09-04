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
