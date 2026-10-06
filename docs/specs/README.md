# Design specs

Design and decision records. Implemented decisions are historical records;
proposed designs do not establish available functionality. Use the
[roadmap](../roadmap.md), [porting status](../porting-status.md) and linked
verification records for current delivery status. Comments cite these files as
"the design" or "the spec"; use the full filename, because both section numbers
and some older document prefixes are shared.

| # | Document | Covers | Cited in code as |
|---|---|---|---|
| [0001](0001-product-design.md) | Product design | Positioning, stack, phasing | "the product design" |
| [0002](0002-design-system.md) | Design system & UX constitution | Tokens, shell, the five UX-constitution rules | "the design-system spec/design" |
| [0003](0003-ai-generation-engine.md) | AI generation engine | Increment 1 — BYOK credentials, the run state machine, the five-role chain, cost accounting, provenance's first cut | "the generation-engine spec" |
| [0004](0004-provenance-lens.md) | The provenance lens | Increment 2a — the sentence-dimming editor overlay, the splitter, the per-channel counter | "the provenance-lens design/spec" |
| [0005](0005-authorship-per-sentence.md) | Authorship, per sentence | Increment 2b-1 — the publish gate and origin badge reasoning per sentence, ahead of the refine verbs | "the authorship-per-sentence spec/design" |
| [0006](0006-api-can-call-a-model.md) | The API can call a model | Increment 2b-2a — provider resolution, cancellation and abort accounting for an editor-side model call | not yet cited by name in code comments as of this copy |
| [0007](0007-partial-delivery-design.md) | Partial delivery: what a half-sent post is | Issue #16 — what an item whose channels disagree IS, the `unknown` refusal and its human resolver, `nextItemStatus` as the one promotion rule | shipped; cited by section number (§4.2, §4.3, §4.4) in the content repository and the item screen |
| [0008](0008-schedule-staleness-design.md) | Schedule staleness: how late is too late | Issue #17 — the worker-side lateness bound and its derived floor, `adaptations.failure_reason` as a closed list, the coded sentence on the screens, the sweep for a `scheduled` or `queued` row whose queue job is gone | shipped; cited as "the staleness design/bound" in the publish repository, the worker's env schema and `docs/lock-order.md` |
| [0009](0009-queue-paging-design.md) | Queue paging | Bounded list pages, batched adaptation queries and cursor semantics | queue paging design |
| [0010](0010-scoped-draft-write-api.md) | Scoped draft writes | Paid BYOK consent, scoped API/MCP operations, durable replay and imported-draft review | scoped draft write design |
| [0011](0011-recurring-editorial-plans.md) | Weekly editorial plans | Finite weekly generation, preview, paid enablement, dispatch and occurrence evidence | recurring plan design; feature release tracked in the roadmap |
| [0012](0012-evergreen-draft-reuse.md) | Evergreen draft reuse | Manually confirmed saved-master generation, lineage, replay and source erasure | local integration and built-browser acceptance complete; main release pending |
| [0013](0013-telegram-draft-decisions.md) | Telegram draft decisions | Verified identity, private draft rejection, snapshot checks and callback replay | proposed design; reviewed findings closed, implementation gates remain |
| [0024](0024-competitive-parity.md) | Competitive parity | Core review and composer, safe posting queues, publication calendar, native destinations, team workflows and supported results/inbox | competitive parity design; implementation tracked in Beads and the roadmap |
| [0025](0025-native-publication-lifecycle.md) | Native publication lifecycle | Connection identity, explicit permissions, accepted nonpublic receipts, LinkedIn and self-hosted WordPress | proposed native lifecycle; availability requires implementation and acceptance evidence |

## Additional historical design files

These older files reuse numeric prefixes. Their full filenames identify distinct
features; the prefix alone is not a unique spec identifier. Front matter records
the original design stage and can predate implementation. Consult current source
and the roadmap before treating a proposed contract as shipped.

| Document | Scope |
| --- | --- |
| [Paid reply analysis](0002-paid-reply-analysis.md) | Explicit paid consent after bounded automatic Telegram reply collection |
| [Versioned role templates](0003-versioned-role-templates.md) | Versioned generation-role configuration and run snapshots |
| [Rich master editor](0004-rich-master-editor.md) | Structured master text, plain-text projection and revision concurrency |
| [Telegram long posts](0004-telegram-long-posts.md) | Reviewed bounded multi-message Telegram delivery |

## Recorded implementation deviations

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

`0008` has shipped, in four parts (the bound and the reason column; the
sentences the screens say; the no-job sweep; these docs), WITH THE FOUR
DEVIATIONS BELOW. Its front matter also still says DECIDED, and the CODE is the
answer on all four:

1. **The two arms of the lateness check sit on opposite sides of the claim.**
   §2 argues at length that the check goes AFTER `claimSend`, and for the LATE
   arm that is exactly right — it says "never sent", which an unresolved claim
   would make a lie. The FUTURE arm is in the code ABOVE the claim, because it
   makes no statement at all: it leaves the row as the person just re-approved
   it, and claiming first would move the row to `publishing`, bump its count and
   leave a claim for the new job to report an unknown outcome about. The
   snapshot that arm answers from is closed by fencing `markPublishing` on
   `scheduled_at`, which §2 does not describe.
2. **There are ten reason codes, not nine.** `rejected_before_send` was split
   off `platform_rejected` while landing: the screen quotes `last_error`
   verbatim beside that code, so one code for both read "The platform refused
   this post: Text must be 1..4096 characters" — our own pre-flight words
   attributed to Telegram, about a request that never left. Which class a
   permanent refusal is comes from the error type the adapter raises, never from
   reading the message.
3. **The screen's hours are frozen by the RECEIPT, not by the sentence.** §2
   asked for the number to be read back out of the prose T1 wrote, on the
   correct grounds that `scheduled_at` survives a failure and a figure
   recomputed at render would grow for ever. Reading a digit back out of a log
   line is the defect `apps/web/src/lib/adaptations.ts` exists to have ended, so
   the api returns `lateBySeconds` as a column instead: for a failed delivery it
   is the newest receipt's `created_at` minus the slot, measured by Postgres —
   frozen at the moment we declined, and derived from the record rather than
   from a sentence. The live case is a different question and is answered
   separately: an overdue row that has not failed is painted from
   `scheduled_at` against the reader's own clock, with
   `SCHEDULED_DISPATCH_WINDOW_SECONDS` of margin so an ordinary hand-off is not
   reported as an outage.
4. **The no-job sweep's `queued` arm records `send_abandoned`, not
   `schedule_missed`.** §2's reason table puts both of its unclaimed arms on
   `schedule_missed`. A `queued` row has no slot — "Publish now" writes
   `scheduled_at = null` — so that code would render as "missed its slot by
   — h", a claim about a time that does not exist. `send_abandoned`'s own
   definition is the true sentence about such a row.

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
