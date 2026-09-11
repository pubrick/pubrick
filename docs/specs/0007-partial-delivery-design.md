# Partial delivery: what a half-sent post is (Design)

**Date:** 2026-09-11
**Status:** PROPOSAL. Nothing here has shipped; the owner picks an option. Where
this document and the code disagree today, the code is right — every claim
about current behaviour below cites `file:line`.
**Covers:** issue #16, split out of #13. One channel publishes, another fails;
the item never reaches a terminal status, and `content.e2e.spec.ts:868` pins
that as intended.
**Not in the index** (`docs/specs/README.md`): the index lists decisions the
codebase lives with. A row lands with the implementation of whichever option
is chosen.

---

## 1. What a partly delivered post IS today

Two channels, approved together. Channel A publishes, channel B fails
permanently (Telegram 400).

**The rows.** `markPublished` writes A's adaptation `published`
(`apps/worker/src/publish/publish.repository.ts:602`) and `markFailed` writes
B's `failed` (`…/publish.repository.ts:733`); each ends in
`recomputeItemStatus` (`…:639`, `…:788`), which promotes the item only when
`rows.every(published)` or `rows.every(failed)` and otherwise returns without
writing (`…/publish.repository.ts:1110-1113`). Neither holds, so
`content_items.status` stays `approved` — the value `approve` wrote
(`apps/api/src/content/content.repository.ts:2719`) — for ever. Nothing else
recomputes it: this function is the only writer of that promotion and it only
ever runs from a delivery.

**`deliveryOutcome`.** A is `published` (and carries `externalUrl`,
`content.repository.ts:469`); B is `failed`, or `unknown` when its last
finished receipt says so (`content.repository.ts:513-525`). The item's own
`status` is `approved`, which the web paints in `scheduled`'s blue
(`apps/web/src/lib/adaptations.ts:69`) — the colour of work in flight, about a
post where nothing is in flight at all.

**The queue screen.** The card is not drawn as failed: that is keyed on
`item.status === "failed"` (`apps/web/src/app/[locale]/content/page.tsx:410`),
so the title stays neutral and no "Try again" affordance appears
(`…/page.tsx:419-427`). The card files under the **Approved** heading, not the
failures-first one (`…/page.tsx:48-51`). The channel lines each carry their own
delivery badge (`…/page.tsx:437`) — green for A, red for B — so the only
statement that a half is broken is one chip on one sub-line under a blue
"Approved" heading. Polling stops: `contentSettled` is "no adaptation queued or
publishing" (`…/page.tsx:145-146`, `lib/adaptations.ts:85-98`), and both halves
are terminal.

**The item screen.** Header badge reads "Approved" (`…/content/[id]/page.tsx:845`).
The deliveries list shows both outcomes with `lastError` under the failed one
(`…/[id]/page.tsx:1221-1264`). `itemSettled` is the same predicate, so the poll
stops too (`…/[id]/page.tsx:144`).

**The retry that already exists, unlabelled.** "Publish now" is disabled only
for a *published* item (`…/[id]/page.tsx:829`, `isPublished` at `:795`), so it
is live here. `approve` targets `["pending","failed","scheduled"]`
(`content.repository.ts:2677`) — **not** `published` — so a second press
re-enqueues B alone and cannot re-send A. `requireNotPublished` passes because
the item is `approved` (`content.repository.ts:2262-2277`). So the mechanism is
right and only the *caption* is missing: nothing on either screen says this
post is partly delivered, or that pressing Publish now retries just the broken
half.

**Two things that are wrong rather than merely unsaid.**

1. *The text cannot be corrected.* `approved` is outside
   `EDITABLE_ITEM_STATUSES` (`content.repository.ts:83-87`), and the commonest
   permanent failure IS the content. The only route is Reject → edit → approve,
   which writes `rejected` over an item one of whose channels is live
   (`content.repository.ts:2786`) — pinned by its own e2e test,
   `content.e2e.spec.ts:842`.
2. *An `unknown` half is re-sent without a word.* The adaptation column has no
   `unknown`, so `markFailed(outcome: "unknown")` stores `failed`
   (`publish.repository.ts:733`, `publish.service.ts:468`). `approve`'s target
   set is read off that column, so "Publish now" re-enqueues an unknown
   delivery exactly like a failed one. The only defence is a sentence on the
   screen (`…/[id]/page.tsx:1257`, `Content.unknownOutcome`) asking the reader
   to check the channel first. **Every option below must answer this, and none
   of them is complete without an api-side refusal.**

---

## 2. Options

### (a) A new item status — `partially_published`

*State machine.* `recomputeItemStatus` gains a third verdict: every adaptation
terminal AND at least one `published` AND at least one not → `partially_published`.
Terminal in the sense that no job is outstanding, but **not** final: a later
delivery recomputes the item, so a successful retry of B promotes it to
`published` on its own. It must be in `EDITABLE_ITEM_STATUSES` (the failed half
usually failed on its text) and must NOT be refused by `requireNotPublished` —
the whole point is that a retry is still available.

*DB cost.* One value added to `CONTENT_STATUSES`
(`packages/shared/src/dto/content.ts:20`) ⇒ a migration rewriting
`content_items_status_check` (`packages/db/src/schema/content-items.ts:71`),
which `schema-invariants.test.ts` asserts in both directions (`:79`, `:97`),
plus the literal list pinned at `packages/db/src/generation-schema.test.ts:63`.

*Shared/web totality cost.* `PINNED_ITEM_MESSAGE` and `PINNED_ITEM_CODE`
(`content.repository.ts:103`, `:121`) are `Record<PinnedItemStatus, …>` and stop
compiling until the status is classified editable or pinned — by design.
`CONTENT_BADGE_STATUS` (`lib/adaptations.ts:67`) needs a colour from the five;
`review`'s brick is the honest one (something waiting on a human).
`Content.status.*` in four locales (`apps/web/messages/{en,es,ru,pt}.json`),
enforced by `messages-parity.test.ts`. It also joins the queue's filter tabs and
its section headings automatically (`content/page.tsx:39`, `:48`) — free, and
correct.

*What the person sees.* A distinct badge and a section of its own; the failed
channel's red chip now sits under a heading that agrees with it; the text is
editable; Publish now retries the broken half.

*What stays true.* The published half is never re-sent (`approve`'s target set).
One server-computed verdict, so queue and item screen cannot disagree.

*What could lie.* The caption "partly published" is a claim about a delivery
whose outcome may be `unknown` — the item would read "partly published, partly
failed" about a post that may well be live. And a status added without also
naming it in `DEMO`-style registries is not a risk here, but adding it to
`CONTENT_STATUSES` without deciding editability is — which the two `Record`s
already make a compile error.

### (b) No new status: derive the caption from the adaptations

*State machine.* Unchanged. The item stays `approved` for ever on a partial
fan-out; the queue card and the item header derive "partly delivered" from
`adaptations` — some `published`, none outstanding.

*DB cost.* None. *Totality cost.* No `Record` breaks, so nothing forces the
question to be answered again anywhere; two screens must derive the same
predicate, which is exactly the failure mode `deliveryOutcome` was moved into
SQL to end (`content.repository.ts:493-500`). Locale cost: one caption ×4.

*Retry per adaptation.* **There is none today** — the api exposes no
`/adaptations/:id/approve`; the routes are `content.controller.ts:37-175`, and
the only retry is the item-level `POST :id/approve`. Adding one is a new route,
a new lock path (`lockAdaptations` is per item, `content.repository.ts:2587`)
and a new way to bypass `requireHumanInvolvement`. Option (b) as written in the
issue therefore costs *more* code than (a), not less.

*What stays true.* No migration, no risk to the CHECK constraint.

*What could lie.* The item's own status stays `approved` in the database and in
the api response, so anything reading `status` — a filter tab, an export, the
`?status=` query (`content.repository.ts:751`), a future report — still says
"Approved" about a post that is finished. The screen would be telling one story
and the field another, indefinitely.

### (c) Item → `failed` when any adaptation failed terminally

*State machine.* `recomputeItemStatus`'s second clause becomes `some` rather
than `every`. `failed` is already editable (`content.repository.ts:83`) and
already re-approvable, so correction and retry work with no other change, and
`approve` still cannot re-send the published half.

*DB cost.* None. *Totality cost.* None — every `Record` already has a `failed`
key; the queue already sorts failures first and already draws the red title and
the "Try again" link (`content/page.tsx:410`, `:419`).

*What stays true.* The strongest prompt to act, at the lowest cost, and the
delivered halves are still shown as delivered by their own badges.

*What could lie.* The item-level word. A post that reached three of four
channels reads "Failed" in the queue, in the filter, and in every future
consumer of `status`; the success is visible only by reading the channel lines.
`publish.repository.ts:1083` warns about the mirror-image mutation (`every` →
`some` on the *published* clause) and `publish.repository.spec.ts:1465` records
that it once survived the whole suite — the same one-word edit in the other
clause deserves the same suspicion.

### Where each option puts `unknown`

An `unknown` half must never be auto-retried, and is stored as `failed`
(§1). So:

- **(a)** treat `unknown` as neither delivered nor failed: an item with an
  unknown half is `partially_published` only if some other half published,
  and in all cases `approve` must REFUSE while any adaptation's
  `deliveryOutcome` is `unknown`, with a code of its own
  (`content_delivery_unknown`) telling the reader to check the channel. The
  refusal is the only thing that makes the screen's sentence enforceable.
- **(b)** the same refusal, plus: a per-adaptation Retry button must be absent
  (not merely warned about) on an unknown row.
- **(c)** `unknown` rounds into `failed` at the item level too — the loudest
  colour on the outcome the product says is neither a success nor a failure,
  and the state most likely to be re-approved in one click from a red card.
  (c) needs the api refusal most and fits it worst.

---

## 3. Recommendation

Take **(a)**, with the `approve` refusal for `unknown` as a *separate,
prerequisite* commit. It is the only option where the stored `status` is true
on its own — (b) leaves the database saying "Approved" for ever and moves the
verdict into two screens that have already disagreed once, and (c) buys its
zero cost by calling a three-of-four delivery "Failed" in every consumer of the
field. The costs (a) really carries are a migration, one CHECK rewrite pinned
both ways, a colour, and four locale strings — and each of them is a place the
product already forces the question to be answered rather than a place it can
be forgotten. `partially_published` should be editable and re-approvable, not
final: it is a waiting state that clears when the failed half is retried, which
is what `recomputeItemStatus` gives for free since it runs on every delivery.
The `unknown` refusal is worth shipping first and alone, because it is a real
duplicate-post hole today under any of the three options, and the screen's
warning sentence is not a control.

**The test to change:** `apps/api/src/content/content.e2e.spec.ts:842` ("a
rejected partial fan-out is editable, except the channel that already
published"), whose comment at `:868` is what pins the gap. It should assert
that after one half publishes and the other fails terminally the item reads
`partially_published` — not `approved` — that the body is editable without a
reject, that a second approve re-queues only the failed adaptation and leaves
the published one `published` with its `externalUrl`, and that when that retry
lands the item becomes `published`. Its existing reject-path assertions stay:
rejecting a fan-out whose other half is still *queued* is a different case and
still ends at `rejected`.

**Seams a whole-branch review should attack:** the `some`/`every` clauses in
`recomputeItemStatus` under mutation (the sibling mutation survived a whole
suite once, `publish.repository.spec.ts:1465`); the parent-lock argument at
`publish.repository.ts:1088` once there are three verdicts rather than two;
`requireNotPublished` (`:2262`) and `requireScheduleReachesEveryChannel`
(`:2188`) meeting the new status; whether `EDITABLE_ITEM_STATUSES` admitting it
lets an edit land under a *live* adaptation (it must not — the guard is that no
adaptation is outstanding, not that the item is editable); the `unknown` refusal
tested at its CALL SITE in `approve`, not only as a predicate; and the four
locale files plus `ERROR_MESSAGE_KEYS` (`apps/web/src/lib/api.ts:81`) for the
new code.

---

## 4. Out of scope

- The other #13 follow-ups: queue pagination/N+1, the `publishing`
  reconciliation sweep beyond what `sweepAbandoned` already does, `format` /
  `disableLinkPreview` wiring, the staleness bound on a late-scheduled post,
  `createQueue` updates.
- The residual duplicate-send window (#13's last bullet): an idempotency key or
  a claimed-send row is a different decision and does not block this one.
- A per-channel Retry control, unless the owner picks (b) — under (a) the
  item-level Publish now already retries exactly the failed halves.
- Notifications of any kind. This design changes what a screen SAYS, not who
  gets told.
- Backfilling items already stranded at `approved` with a mixed fan-out: worth
  a one-off recompute, but it is an operational step, not a design decision.
