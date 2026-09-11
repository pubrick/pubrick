# Partial delivery: what a half-sent post is (Design)

**Date:** 2026-09-11 (revision 2, after the adversarial review)
**Status:** DECIDED, not implemented. Option (a) — a new item status
`partially_published` — with the `unknown` refusal shipped as a PAIR with its
human resolver. Revision 1 offered three options; the comparison is gone, the
verdict and its costs are what is left. Where this document and the code
disagree, the code is right — every claim about current behaviour cites
`file:line` at `e3d4cda`.
**Covers:** issue #16, split out of #13. Lands in `docs/specs/README.md` with
the implementation.

---

## 1. What a partly delivered post IS today

Two channels approved together; A publishes, B fails permanently (Telegram 400).

**The rows.** `markPublished` writes A's adaptation `published`
(`apps/worker/src/publish/publish.repository.ts:602`) and `markFailed` writes B's
`failed` (`…:745`); both end in `recomputeItemStatus` (`…:639`, `…:788`), which
promotes only on `rows.every(published)` or `rows.every(failed)` and otherwise
returns without writing (`…:1108-1113`) — so `content_items.status` stays
`approved`, the value `approve` wrote
(`apps/api/src/content/content.repository.ts:2719`), for ever.

**`deliveryOutcome`.** A is `published` with an `externalUrl`
(`content.repository.ts:469`); B is `failed`, or `unknown` when its last
finished receipt says so (`…:513-525`). The item's `status` is `approved`,
painted in `scheduled`'s blue (`apps/web/src/lib/adaptations.ts:69`) — the
colour of work in flight, about a post where nothing is in flight.

**The screens.** The queue's red title and "Try again" link are keyed on the
literal `item.status === "failed"`
(`apps/web/src/app/[locale]/content/page.tsx:410`, `:419-427`), so the card is
neutral under **Approved** (`…:48-51`) with a delivery badge per channel line
(`…:437`); polling stops, since `contentSettled` is "no adaptation queued or
publishing" (`…:145-146`, `lib/adaptations.ts:85-98`). The item screen reads
"Approved" (`…/content/[id]/page.tsx:845`), lists both outcomes (`…:1221-1264`)
and stops polling too (`…:144`).

**The retry that exists, unlabelled.** "Publish now" is disabled only for a
*published* item (`[id]/page.tsx:829`, `isPublished` `:795`), and `approve`
targets `["pending","failed","scheduled"]` (`content.repository.ts:2677`) —
not `published` — so a second press re-enqueues B alone and cannot re-send A;
`requireNotPublished` passes because the item is `approved` (`…:2262-2276`).
The mechanism is right; the caption is missing.

**Two things that are wrong rather than unsaid.**

1. *The text cannot be corrected.* `approved` is outside
   `EDITABLE_ITEM_STATUSES` (`…:83-87`), and the commonest permanent failure IS
   the text. The only route is Reject → edit → approve, which writes `rejected`
   over an item one of whose channels is live (`…:2786`).
2. *An `unknown` half is re-sent silently.* The adaptation column has no
   `unknown`, so `markFailed(outcome:"unknown")` stores `failed`
   (`publish.repository.ts:745`, `publish.service.ts:468`), and approve's target
   set is read off that column. The only defence is two sentences on two screens
   (`[id]/page.tsx:1259` **and** `content/page.tsx:447-451`,
   `Content.unknownOutcome`) — advice, not a control. No api-side refusal
   exists; `ERROR_MESSAGE_KEYS` (`apps/web/src/lib/api.ts:81`) has no such key.

---

## 2. The status: `partially_published`, a WAITING state

`recomputeItemStatus` gains a third verdict: every adaptation terminal AND at
least one `published` AND at least one not. Terminal in the sense that no job is
outstanding, **not** final — a later delivery recomputes the item, so a
successful retry of B promotes it to `published` on its own. It is editable
(§4.3) and is not refused by `requireNotPublished` for approve.

**Writers of `content_items.status`:** `create` (column default `draft`),
`approve` → `setItemStatus("approved")` (`content.repository.ts:2719`),
`reject` → `rejected` (`:2786`), and `recomputeItemStatus`
(`publish.repository.ts:1088`), the only promoter. Its callers are **four**, not
the three its docstring lists (`:1078-1081`): `markPublished`,
`markAlreadyPublished`, `markFailed`, and **`sweepAbandoned`** (`:984`), which
loops the recompute over every swept row in one transaction and is also the path
that mints `unknown` (`:971`, `case when claimed then 'unknown'`) — so it is the
path that will mint `partially_published` in batches at 3am. The docstring is
corrected in the same commit as the verdict.

| Reader | `file:line` | Decision |
|---|---|---|
| `EDITABLE_ITEM_STATUSES` | `content.repository.ts:83` | add it (§4.3) |
| `PINNED_ITEM_MESSAGE` / `_CODE` | `:103`, `:121` | nothing — editable, so not a key |
| `requireEditableItem` (`PATCH :id`) | `:1070`, `pinnedItemRefusal` `:191` | allow |
| `refinableItem` (`POST :id/refine`) | `:1329-1346` | allow, deliberately (§4.3) |
| `requireNotPublished` | `:2262` | pass for approve, **refuse for reject** (§4.2) |
| `list(?status=)` | `:751-761` | free |
| worker publish gate | `publish.service.ts:158` | nothing |
| `recomputeItemStatus` | `publish.repository.ts:1111` | the third verdict |
| `CONTENT_BADGE_STATUS` | `adaptations.ts:67` | `review`'s brick |
| queue filter tabs | `content/page.tsx:39` | free |
| queue sections `GROUP_STATUSES` | `content/page.tsx:41-51` | **order is not free** (§4.1) |
| queue "is this a failure" | `content/page.tsx:410` | **a literal no type guards** (§4.1) |
| item header badge | `[id]/page.tsx:845-846` | `Content.status.*` ×4 locales |
| `CONTENT_STATUSES` literal | `generation-schema.test.ts:63` | update |
| CHECK, both directions | `schema-invariants.test.ts:79`, `:97` | migration (§5) |

The two `Record`s make a forgotten decision a compile error; the two lines in
`content/page.tsx` are string literals, and being named here is the only guard
they get.

---

## 3. `unknown`: the refusal ships WITH its resolver

**The refusal.** `approve` skips any adaptation whose `deliveryOutcome` is
`unknown` instead of re-enqueuing it — per target row, not per item, so a
four-channel post with one unknown half still re-sends the halves that are
provably undelivered. If that leaves the target set **empty** while an unknown
row exists, it refuses with `delivery_outcome_unknown` rather than returning a
200 that did no work. The read sits AFTER `lockAdaptations` (`:2677`,
`:2587-2610`), for the reason `requireNotPublished:2248-2262` gives: a pre-lock
read of delivery state is stale against a landing worker. No new lock and no
order change (`docs/lock-order.md`).

**Why it cannot ship alone.** Nothing moves an adaptation off `failed`+unknown
except `approve` (`:2677`) — `reject` touches only outstanding rows (`:2763`),
`PATCH` writes bodies, a new receipt needs a delivery, `sweepAbandoned` acts
only on `publishing` rows — so a refusal alone leaves the post finishable only
by deleting the channel, against this product's own standard
(`requireScheduleReachesEveryChannel:2180-2187`: *a refusal that a retry clears
is the fail-safe direction*).

**The resolver.** `POST /api/content/:id/adaptations/:adaptationId/delivery`,
per adaptation, offered only on an `unknown` row:

- **"Mark as delivered"** → a `published` `publications` receipt and the
  adaptation `published`. The receipt carries `asserted_by` (the user id) and no
  `external_url`; worker-written rows leave it null. This also stops a re-send
  by itself, since `alreadyDelivered` reads a `published` receipt
  (`publish.repository.ts:405-420`) — whose docstring, "a `published`
  publications row means a platform genuinely accepted a post", is amended to
  "…or a named person asserted it" in the same commit.
- **"Mark as not delivered"** → a `failed` receipt with `asserted_by`. The
  adaptation stays `failed`, `deliveryOutcome` stops being `unknown`
  (`content.repository.ts:513-525` reads the last finished receipt), and approve
  clears — the standard shape.

Refusals reuse the existing codes where a code exists: an in-flight row answers
`adaptation_pinned_queued`/`_publishing`/`_scheduled`/`_published`. A row whose
outcome is simply known needs a second new code,
`delivery_outcome_not_in_doubt`: one code cannot mean both "in doubt, refused"
and "not in doubt, refused", since codes here are nullary and named by state
(`packages/shared/src/dto/errors.ts:327`). `ERROR_MESSAGE_KEYS` (`api.ts:81`)
is total, so both are compile-enforced into four locales. Locks: `adaptations`
(FOR UPDATE, one row) → `content_items` (FOR UPDATE, for the recompute) — the
documented order, the one `approve` takes.

**ONE definition of the verdict, not three.** A TS-side unknown rule would copy
`deliveryOutcome` into the worker and a third time into the migration. So the
definition moves the way `deliveryOutcome` itself moved
(`content.repository.ts:493-500`): into SQL, once.

- `adaptation_delivery_outcome(adaptation_id uuid, status text) → text` — the
  body of `content.repository.ts:513-525` verbatim; the api's
  `ADAPTATION_COLUMNS` expression becomes a call to it.
- `recompute_content_item_status(org_id text, item_id uuid) → void` — the body
  of `publish.repository.ts:1099-1113`. The worker keeps its `FOR UPDATE` on the
  parent in TS, where the lock argument is documented, then calls it; the api's
  resolver calls the same function instead of growing a second copy; the
  backfill (§5) calls it over candidate rows instead of restating the predicate.

Precedent: `publications_stamp_deleted_channel` (migration 0011) is already
product logic in the database, for the same reason. The cost is honest: a
function body in a `.sql` file is not type-checked and changes by
`CREATE OR REPLACE`. §6 pins it from all three call sites.

**The `{failed, unknown}` item** — no half published — stays `failed`, keeps its
red card and its "Try again" (`content/page.tsx:410`, `:419-427`). Without the
resolver that link would 409 for ever; with it, the item screen offers the
verdict that unblocks it. Hence the pair.

---

## 4. What the person sees

### 4.1 The queue

`partially_published` goes into `CONTENT_STATUSES`
(`packages/shared/src/dto/content.ts:20`) **directly after `approved`**, and is
hoisted into `GROUP_STATUSES`' failures-first head beside `"failed"`
(`content/page.tsx:41-51`): that list is `["failed", ...rest]`, so appending
would sort a half-broken post below `published`, last heading on the page — the
exact regression the comment at `:41-47` exists to end.

`content/page.tsx:410`'s flag becomes "this post needs a person":
`item.status === "failed" || item.status === "partially_published"`. Both the
danger title and the Try again link follow it; without this the new heading buys
a colour and no affordance.

### 4.2 Reject is gated on "any adaptation published"

Reject on a partly-live post is a **one-way door**: it writes `rejected`
(`:2786`) over an item with a live channel, and `recomputeItemStatus` — the only
writer that could bring it back — runs only from a delivery. So the gate stops
being about the item's status: `requireNotPublished` (`:2262`) refuses when
**any** adaptation is `published`, and the button (`[id]/page.tsx:1206`,
`isPublished` `:795`) is disabled on the same condition derived from
`item.adaptations`. The existing `content_already_published` code and sentence
still fit.

**What a person does instead, to stop a partly-delivered post: nothing.**
Nothing re-sends by itself — the failed half moves only on an explicit approve
(`:2677`) — so leaving the item where it is IS the stop, and the item screen
says that in one sentence beside the disabled Reject. Priced and rejected: a
per-adaptation "Give up" writing an `abandoned` adaptation status costs a value
in `ADAPTATION_STATUSES` (`dto/content.ts:23`), a second CHECK rewrite, a fourth
verdict in the recompute, a badge colour and a route — to buy a tidier queue and
nothing else, since there is no `DELETE /content/:id`
(`content.controller.ts:37-175`) and the post stays live either way.

### 4.3 Editing (and refine) are allowed, with a sentence

The commonest permanent failure is the text and Reject is now closed (§4.2), so
forbidding the edit would leave no way to fix the thing that failed.
`partially_published` joins `EDITABLE_ITEM_STATUSES`, and `refinableItem`
(`:1329-1346`) follows through `pinnedItemRefusal` — deliberately: refine edits
the same body under the same gate, and a paid call the reader chose is not a
worse risk than a keystroke.

The price, stated: `update` rewrites `content_items.body` (`:1148-1163`), and
the delivered channel has no stored copy of what it sent — `humanVersionBody`
(`:640-644`) files the NEW text, so "the history preserves it" would be false.
The record of what went out is the receipt and the live post
(`publications.external_url`, surfaced at `:469`), unchanged by an edit. The
item screen therefore carries one sentence above the editor naming the channels
that already received the previous text, in four locales.

### 4.4 "Publish now" says what it will re-send

On a `partially_published` item the primary button (`[id]/page.tsx:829`,
`Publish.approveNow`) reads "Send to the {count} channel(s) that failed",
counting adaptations whose `deliveryOutcome` is `failed` — unknown rows are
excluded, because §3 will not send them. An ICU plural in four locales; the
label is status-conditional and the ordinary "Publish now" is untouched.

---

## 5. The migration, the backfill and the deploy

Two migrations, because §3's pair ships before the status (§8). **0017** —
`publications.asserted_by` and both SQL functions, `recompute_content_item_status`
created with today's two verdicts. **0018** — `CREATE OR REPLACE` of the
recompute with the third verdict, the `content_items_status_check` rewrite
(`packages/db/src/schema/content-items.ts:71`, built from `CONTENT_STATUSES`),
then the backfill. The next free tag is **0017**: `0010` is absent from
`meta/_journal.json` (`0009` → `0011`) and must not be filled.

**The backfill** runs after the CHECK rewrite in the same file, or it violates a
constraint it has not yet widened. It selects candidates and calls the function:

```
status = 'approved'
and exists (select 1 from adaptations a where a.content_item_id = ci.id)
and not exists (select 1 from adaptations a
                 where a.content_item_id = ci.id and a.status not in ('published','failed'))
and exists (select 1 from adaptations a
             where a.content_item_id = ci.id and a.status = 'published')
```

`exists`, never `bool_and`/`bool_or`: the empty-adaptation guard is load-bearing
(`publish.repository.ts:1108` returns on `rows.length === 0`, and `bool_and`
over an empty set is `NULL`). Mid-delivery rows are excluded by construction —
an item with a `queued` half fails the `not exists` clause, and the worker's own
recompute answers correctly when it lands.

**`expectNoRowRewritten`** (`migrate.test.ts:279-300`, invoked `:978`) asserts
no pre-existing `content_items` value is rewritten from 0009 to head, and its
comment names backfills as "precisely the class this test exists to catch". It
is green today only because `seedEveryTable` (`:186-234`) seeds one `draft` item
the predicate cannot match. So the backfill's test is a **new `it` with its own
seed**, and the stranded fan-out must **not** go into `seedEveryTable`. The
migration carries a comment saying why this rewrite is the exception — it
repairs rows the ratchet's invariant protects from a different harm — or the
next reader will "fix" it.

**Rolling deploy.** The backfill makes `partially_published` reach api responses
at the instant of deploy, and an old web bundle renders
`CONTENT_BADGE_STATUS[status]` as `undefined` (`adaptations.ts:67`) plus a
missing next-intl key. `docker compose up -d --build` rebuilds everything
together and needs no care; anyone rolling services one at a time deploys **web
before the migration**. One paragraph in `docs/self-hosting.md` §Upgrade, beside
the worker-before-api rule already there.

---

## 6. Tests

Nothing pins the gap today. `content.e2e.spec.ts:842` ("a rejected partial
fan-out is editable…") leaves the second adaptation **`queued`** (`:868-876`),
so its `:868` comment pins the one-published-one-still-queued case — correct
behaviour, not the gap. `grep "clean sweep"` returns that one hit;
`publish.repository.spec.ts:1472` and `:1503` are likewise about non-terminal
siblings. Revision 1 nominated `:842` as "the test to change" and was wrong.

- `apps/api/src/content/content.e2e.spec.ts:842` — **unchanged**, except its
  `:868` comment, which stops claiming to pin the terminal case.
- `apps/worker/src/publish/publish.repository.spec.ts` — new, beside `:1472`:
  `seedFanOut(["publishing","queued"])` → `markPublished(first)` →
  `markFailed(second)` → item `partially_published`; the retry lands →
  `published`. One test per arm of the three-way verdict, each failing when that
  arm alone is mutated, plus the mirror that stops it being satisfied by
  deleting an arm the way `:1503` does; and `sweepAbandoned` over a mixed
  fan-out reaching the same verdict.
- `apps/api/src/content/content.e2e.spec.ts` — new: terminal mixed fan-out reads
  `partially_published`; `PATCH :id` 200s with no reject; refine is not pinned;
  a second approve re-queues ONLY the failed adaptation and leaves the published
  one `published` with its `externalUrl`; `?status=partially_published` lists
  it; **reject 409s**; approve with an unknown half enqueues the failed halves
  and skips the unknown one; approve whose only target is unknown 409s
  `delivery_outcome_unknown`; both resolver verdicts, each followed by the
  approve that now works; the resolver on a queued row answers
  `adaptation_pinned_queued`.
- `packages/db/src/migrate.test.ts` — new `it` with its own seed (§5): a
  stranded fan-out seeded at the 0017 schema via `migrationsFolderBefore`
  (`:336`, precedent `:946-987`); the mixed item becomes `partially_published`,
  the one-published-one-queued item does not, an item with no adaptations does
  not.
- `packages/db/src/schema-invariants.test.ts` — both functions exist; the CHECK
  matches `CONTENT_STATUSES` both ways (`:79`, `:97`) with the new value. Plus a
  ratchet that the `unknown` case-expression exists in exactly ONE place, so a
  future reader cannot re-inline it into TS.
- Web (`messages-parity.test.ts` for the keys ×4): the queue draws a
  `partially_published` card with the danger title and a Try again link; the item
  screen disables Reject when any adaptation is published; the Publish-now label
  counts only `failed` outcomes.

Mutation testing per `docs/mutation-testing.md` on the three verdict arms, the
"any published" reject gate, and the per-row unknown skip.

---

## 7. Out of scope

The other #13 follow-ups (queue pagination/N+1, reconciliation beyond
`sweepAbandoned`, `format`/`disableLinkPreview`, the staleness bound,
`createQueue`); the residual duplicate-send window; a per-channel Retry control
(item-level Publish now already retries exactly the failed halves);
notifications of any kind; an `abandoned` adaptation status (§4.2).

---

## 8. Tasks

Ordered; each is one commit. "Pair" answers: is the gate green with only the
first of the pair?

### T1 — the `unknown` refusal and its resolver (api + web + migration 0017)

*Files:* `packages/db/migrations/0017_*.sql`,
`packages/db/src/schema/content-items.ts` (`asserted_by`),
`packages/shared/src/dto/errors.ts`,
`apps/api/src/content/content.{controller,repository}.ts`,
`apps/worker/src/publish/publish.repository.ts` (call the SQL recompute; amend
the `:405-420` and `:1078-1081` docstrings),
`apps/web/src/app/[locale]/content/[id]/page.tsx`, `apps/web/src/lib/api.ts`,
`apps/web/messages/*.json`.
*Steps:* migration (column + `adaptation_delivery_outcome` +
`recompute_content_item_status` with today's two verdicts) → api reads the
function for `deliveryOutcome` → resolver route after `lockAdaptations`, both
verdicts, pinned-code refusals → approve's per-row skip and empty-target refusal
→ two codes ×4 locales → two buttons on an `unknown` delivery row only.
*Tests:* §6's resolver and approve e2e; a worker spec proving the SQL recompute
still yields today's two verdicts; the one-definition ratchet.
*Mutations:* per-row skip → per-item; drop `asserted_by`; empty-target refusal →
200; resolver accepting a known-outcome row.
*Pair:* ships alone and is strictly better than today — it is the pair the
review demanded and needs nothing from T2.
*Agent:* a checkout-isolated api agent (it touches the worker at one call site
and two docstrings).

### T2 — the status (shared + migration 0018 + api gate)

*Files:* `packages/shared/src/dto/content.ts`,
`packages/db/migrations/0018_*.sql`, `packages/db/src/*.test.ts`,
`apps/worker/src/publish/publish.repository.ts` (docstring, if the verdict is
wholly in SQL), `apps/api/src/content/content.repository.ts`
(`EDITABLE_ITEM_STATUSES`, the reject gate).
*Steps:* insert the value after `approved` → CHECK rewrite → `CREATE OR REPLACE`
the recompute with the third verdict → backfill after the rewrite → reject gate
on "any adaptation published".
*Tests:* §6's worker spec, the new `migrate.test.ts` `it`, schema-invariants, the
api e2e for reject 409 and for edit-without-reject.
*Mutations:* each of the three arms; `exists` → `bool_and`; backfill before the
CHECK; reject gate back to the item's own status.
*Pair:* T2 compiles only with the **minimum** of T3 — the badge colour and the
four locale strings, which the two `Record`s force — so those ride in T2 or the
build is red. The rest of T3 is separable.
*Agent:* a db+worker agent in its own checkout; its PostgreSQL suites must be
serialised against any other agent using the same test database.

### T3 — the web (sections, flag, labels, gates)

*Files:* `apps/web/src/lib/adaptations.ts`,
`apps/web/src/app/[locale]/content/page.tsx`,
`apps/web/src/app/[locale]/content/[id]/page.tsx`, `apps/web/messages/*.json`.
*Steps:* the `GROUP_STATUSES` hoist (§4.1) → `:410`'s flag → the edit sentence
(§4.3) → the Publish-now plural (§4.4) → Reject disabled on any published
adaptation → four locale files.
*Tests:* §6's web list; messages-parity.
*Mutations:* drop the status from `:410`'s flag; append rather than hoist in
`GROUP_STATUSES`; count unknown rows in the Publish-now label.
*Pair:* T3 alone is green and invisible until T2's status exists; T2 alone is
green and drab. Either order works.
*Agent:* a web-only agent in its own checkout.

### T4 — docs and CHANGELOG

*Files:* `docs/specs/README.md` (the row), `docs/self-hosting.md` (§Upgrade's
web-before-migration paragraph), `docs/lock-order.md` (the resolver's path),
`CHANGELOG.md` (`Added`: the resolver; `Changed`: the status and what the queue
now says; `Fixed`: the unknown re-send).
*Tests:* none beyond the existing docs checks.
*Pair:* last by construction; nothing depends on it.
*Agent:* a docs agent in its own checkout.
