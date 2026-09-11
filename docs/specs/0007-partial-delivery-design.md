# Partial delivery: what a half-sent post is (Design)

**Date:** 2026-09-11 (revision 3, after the second-pass review)
**Status:** DECIDED, not implemented. Option (a) — a new item status
`partially_published` — with the `unknown` refusal shipped as a PAIR with its
human resolver. Revision 2's two SQL functions are gone: the verdict stays in
`packages/shared`, the rule book (§3). Where this document and the code disagree
the code is right; every claim cites `file:line` at `e3d4cda`.
**Covers:** issue #16, split out of #13. Lands in `docs/specs/README.md` with the
implementation.

---

## 1. What a partly delivered post IS today

Two channels approved together; A publishes, B fails permanently (Telegram 400).
`markPublished` writes A `published`
(`apps/worker/src/publish/publish.repository.ts:602`), `markFailed` writes B
`failed` (`…:745`); both end in `recomputeItemStatus` (`…:639`, `…:788`), which
promotes only on `rows.every(published)` or `rows.every(failed)` and otherwise
returns without writing (`…:1108-1113`). So `content_items.status` stays
`approved` — `approve`'s value (`apps/api/src/content/content.repository.ts:2719`)
— for ever, painted in `scheduled`'s blue (`apps/web/src/lib/adaptations.ts:69`),
the colour of work in flight. A's `deliveryOutcome` is `published` with an
`externalUrl` (`…:469`); B's is `failed`, or `unknown` when its last finished
receipt says so (`…:513-525`).

The queue's red title and "Try again" are keyed on the literal `item.status ===
"failed"` (`apps/web/src/app/[locale]/content/page.tsx:410`, `:419-427`), so the
card is neutral under **Approved** (`…:48-51`) and polling stops (`…:145-146`);
the item screen reads "Approved" (`…/content/[id]/page.tsx:845`) and lists both
outcomes (`…:1221-1264`). The retry exists, unlabelled: "Publish now" is disabled
only for a *published* item (`[id]/page.tsx:829`, `:795`) and `approve` targets
`["pending","failed","scheduled"]` (`:2677`), so a second press re-enqueues B
alone and cannot re-send A.

**Two things wrong rather than unsaid.** (1) *The text cannot be corrected*:
`approved` is outside `EDITABLE_ITEM_STATUSES` (`…:83-87`), so the only route is
Reject → edit → approve, writing `rejected` over an item with a live channel
(`…:2786`). (2) *An `unknown` half is re-sent silently*: the adaptation column has
no `unknown`, so `markFailed(outcome:"unknown")` stores `failed`
(`publish.repository.ts:745`, `publish.service.ts:468`) and approve reads that
column; the only defence is two sentences on two screens (`[id]/page.tsx:1259`,
`content/page.tsx:447-451`) — advice, not a control.

---

## 2. The status: `partially_published`, a WAITING state

The recompute gains a third verdict: every adaptation terminal AND at least one
`published` AND at least one not. Terminal means no job outstanding, **not**
final — a later delivery recomputes the item, so a successful retry of B promotes
it to `published` on its own. It is editable (§4.3) and passes
`requireNotPublished` for approve.

**Writers of `content_items.status`:** `create` (default `draft`), `approve`
(`:2719`), `reject` (`:2786`), `recomputeItemStatus`
(`publish.repository.ts:1088`), and — new in T1 — the resolver, which promotes
after its own write (§3). The recompute's callers are **four**, not the three its
docstring lists (`:1078-1081`): `markPublished`, `markAlreadyPublished`,
`markFailed`, and **`sweepAbandoned`** (`:984`), which loops it over every swept
row in one transaction and also mints `unknown` (`:971`) — so it mints
`partially_published` in batches at 3am. The docstring is corrected in the same
commit as the verdict.

| Reader | `file:line` | Decision |
|---|---|---|
| `EDITABLE_ITEM_STATUSES` | `content.repository.ts:83` | add it (§4.3) |
| `PINNED_ITEM_MESSAGE` / `_CODE` | `:103`, `:121` | nothing — editable, so not a key |
| `requireEditableItem` (`PATCH :id`) | `:1070`, `pinnedItemRefusal` `:191` | allow |
| `refinableItem` (`POST :id/refine`) | `:1329-1346` | allow, deliberately (§4.3) |
| `requireNotPublished` | `:2262` | pass for approve, **refuse for reject** (§4.2) |
| `list(?status=)` | `:751-761` | free |
| worker publish gate | `publish.service.ts:158` | nothing |
| `recomputeItemStatus` | `publish.repository.ts:1111` | third verdict, via `nextItemStatus` (§3) |
| `CONTENT_BADGE_STATUS` | `adaptations.ts:67` | `review`'s brick |
| queue filter tabs | `content/page.tsx:39` | free |
| queue sections `GROUP_STATUSES` | `content/page.tsx:41-51` | **order is not free** (§4.1) |
| queue "is this a failure" | `content/page.tsx:410` | **a literal no type guards** (§4.1) |
| item header badge | `[id]/page.tsx:845-846` | `Content.status.*` ×4 locales |
| `CONTENT_STATUSES` literal | `generation-schema.test.ts:63` | update |
| CHECK, both directions | `schema-invariants.test.ts:79`, `:97` | migration (§5) |

The two `Record`s make a forgotten decision a compile error; the two lines in
`content/page.tsx` are string literals, and being named here is their only guard.

---

## 3. `unknown`: the refusal ships WITH its resolver

**The refusal.** `approve` skips any adaptation whose `deliveryOutcome` is
`unknown` — per target row, so a four-channel post with one unknown half still
re-sends the provably undelivered ones. If that leaves the target set **empty**
while an unknown row exists, it refuses with `delivery_outcome_unknown` rather
than returning a 200 that did no work. The read sits AFTER `lockAdaptations`
(`:2677`, `:2587-2610`), for the reason `requireNotPublished:2248-2262` gives: a
pre-lock read of delivery state is stale against a landing worker. No new lock,
no order change (`docs/lock-order.md`).

**Why it cannot ship alone.** Nothing moves an adaptation off `failed`+unknown
except `approve` — `reject` touches only outstanding rows (`:2763`), `PATCH`
writes bodies, a receipt needs a delivery, `sweepAbandoned` acts only on
`publishing` rows — so a refusal alone leaves the post finishable only by
deleting the channel, against this product's own standard
(`requireScheduleReachesEveryChannel:2180-2187`).

**The resolver.** `POST /api/content/:id/adaptations/:adaptationId/delivery`, per
adaptation, offered only on an `unknown` row. It locks the adaptation FOR UPDATE
and **reads the outcome under that lock**; otherwise two clicks race and the
loser hits `publications_one_published_per_adaptation` as a raw `23505` — a 500 —
instead of a coded refusal. *"Mark as delivered"* writes a `published`
`publications` receipt (carrying `asserted_by`, no `external_url`) and the
adaptation `published`; that alone stops a re-send, since `alreadyDelivered`
reads a `published` receipt (`publish.repository.ts:405-420`) — whose docstring,
"a `published` publications row means a platform genuinely accepted a post", is
amended to "…or a named person asserted it" in the same commit. *"Mark as not
delivered"* writes a `failed` receipt with `asserted_by`; the adaptation stays
`failed`, `deliveryOutcome` stops being `unknown` (`:513-525` reads the last
finished receipt) and approve clears.

Either verdict makes the row terminal, so the resolver then promotes the item as
a delivery does: `content_items` FOR UPDATE → `nextItemStatus` → update. Locks:
`adaptations` (one row) → the `publications` insert (`FOR KEY SHARE` on
`channels`) → `content_items` — the documented order, `markPublished`'s own path;
no new acquisition, no new edge. An in-flight row is refused with the existing
`adaptation_pinned_queued`/`_publishing`/`_scheduled`/`_published`; a row whose
outcome is already known needs a second new code,
**`delivery_outcome_already_known`** — codes here are nullary and named by state
(`errors.ts:327`), so one cannot mean both "in doubt" and "not in doubt", and the
name says the act refused rather than the refuser's mood. **Both are 409**
(`REFUSAL_STATUS_NAME`, `errors.ts:345`); `ERROR_MESSAGE_KEYS` (`api.ts:81`) is
total, so both reach four locales by compile error.

**ONE definition of the verdict, and it stays in the rule book.** Three callers
need the recompute's rule — the worker's bookkeeping, the resolver, the backfill
(§5) — and two are TypeScript. So `nextItemStatus(statuses: AdaptationStatus[]):
ContentStatus | undefined`, a pure fold, lives in
**`packages/shared/src/dto/content.ts`** beside `CONTENT_STATUSES` and
`ADAPTATION_STATUSES`. `packages/shared` is a leaf (one dependency, zod) and
`apps/worker` and `apps/api` both declare it `workspace:*`, so both import it:
`recomputeItemStatus` (`publish.repository.ts:1099-1113`) keeps its `FOR UPDATE`
and its documented lock argument and calls it for the answer; the resolver calls
it under the same parent lock. Two lock dances, one verdict. The backfill is that
fold transcribed into SQL once, and `packages/db/src/migrate.test.ts` runs both
over the same rows (§6) — the shape this repo ships for a rule two languages
need: the spend buckets are stated once in `cost-display.ts`'s doc comment,
transcribed at `ai-credentials.repository.ts:169-200` ("the doc comment on
`cost-display.ts` is the single statement of the rule"), pinned by
`ai-credentials.e2e.spec.ts:1219` — *"gives the same answer as `costTotals()` over
the same rows"*.

**No database function is created**, and revision 2's two are dropped.
`adaptation_delivery_outcome` had one caller (`ADAPTATION_COLUMNS`), so
`deliveryOutcome` stays a Drizzle `sql<DeliveryOutcome>` template at
`content.repository.ts:493-525` — type-parameterised, in git, its 40 lines of
load-bearing reasoning where reviewers read them. And
`recompute_content_item_status` would have made the worker depend on DDL only the
api applies (`runMigrations`: `apps/api/src/main.ts:9`, nowhere else): a new
worker on an old database throws `42883` **after the platform call succeeded**,
stranding the claim and minting the very `unknown` outcomes this spec exists to
reduce — the inversion of `docs/self-hosting.md` §Upgrade's bold *"Deploy the
worker before the api … worker first is always safe."* TS also keeps T2's arm
mutations runnable: an applied migration is never re-applied.

**The `{failed, unknown}` item** — no half published — stays `failed` with its
red card and its "Try again", which without the resolver would 409 for ever.

---

## 4. What the person sees

**4.1 The queue.** `partially_published` goes into `CONTENT_STATUSES`
(`packages/shared/src/dto/content.ts:20`) **directly after `approved`**, and is
hoisted into `GROUP_STATUSES`' failures-first head beside `"failed"`
(`content/page.tsx:41-51`): that list is `["failed", ...rest]`, so appending would
sort a half-broken post below `published`, last heading on the page — the
regression the comment at `:41-47` exists to end. `:410`'s flag becomes
`item.status === "failed" || item.status === "partially_published"`; the danger
title and the Try again link both follow it, without which the new heading buys a
colour and no affordance.

**4.2 Reject is gated on "any adaptation published".** Reject on a partly-live
post is a one-way door: it writes `rejected` (`:2786`) over an item with a live
channel, and the recompute — the only writer that could bring it back — runs only
from a delivery. So `requireNotPublished` (`:2262`) refuses when **any**
adaptation is `published`, and the button (`[id]/page.tsx:1206`, `isPublished`
`:795`) is disabled on the same condition derived from `item.adaptations`;
`content_already_published` still fits. **What a person does instead, to stop a
partly-delivered post: nothing** — nothing re-sends by itself (`:2677`), so
leaving the item where it is IS the stop, said in one sentence beside the
disabled Reject. A per-adaptation "Give up" writing an `abandoned` status is
priced and rejected (§7): a value in `ADAPTATION_STATUSES`, a CHECK rewrite, a
fourth verdict, a colour and a route, for a tidier queue and nothing else.

**4.3 Editing (and refine) are allowed, with a sentence.** The commonest
permanent failure is the text and Reject is now closed, so forbidding the edit
would leave no way to fix what failed. `partially_published` joins
`EDITABLE_ITEM_STATUSES`, and `refinableItem` (`:1329-1346`) follows through
`pinnedItemRefusal`: refine edits the same body under the same gate. The price,
stated: `update` rewrites `content_items.body` (`:1148-1163`) and
`humanVersionBody` (`:640-644`) files the NEW text, so "the history preserves
it" would be false — what went out survives only as the receipt and the live post
(`publications.external_url`, `:469`). So
one sentence above the editor names the channels that already received the
previous text, in four locales.

**4.4 "Publish now" says what it will re-send.** On a `partially_published` item
the primary button (`[id]/page.tsx:829`, `Publish.approveNow`) reads "Send to the
{count} channel(s) that failed", counting adaptations whose `deliveryOutcome` is
`failed` — unknown rows excluded, because §3 will not send them. An ICU plural in
four locales; the ordinary "Publish now" is untouched.

**4.5 A human-asserted delivery says so.** *Shape:* `assertedBy:
text("asserted_by").references(() => user.id, { onDelete: "set null" })` on
`publications` (`packages/db/src/schema/content-items.ts:329`) — the repo's one
precedent for a user pointer, verbatim from `schema/refine.ts:97` and
`schema/generation.ts:348`. **Not `cascade`**: that would destroy the receipt when
the person leaves, migration 0011's loss re-opened from a new side. Nullable by
construction, so no CHECK and nothing for `schema-invariants` to pin. *Its
reader*, without which the column is invisible to every test and the screen lies:
a `published` adaptation with no `external_url` renders `t("linkUnavailable")`
(`[id]/page.tsx:1224-1241`), claiming a platform-confirmed delivery whose link
went missing — exactly what a human assertion is not. So `ADAPTATION_COLUMNS`
grows `assertedByName` (`asserted_by` joined to `user.name`, aliased the way
`invitations.repository.ts:59` aliases an inviter) and `assertedAt` (the receipt's
`created_at`), and that branch renders "Marked as delivered by {name} on {date}"
when a name is present, `linkUnavailable` otherwise, in four locales.
`deliveryOutcome` is unchanged: the sentence is the only place the difference
shows.

---

## 5. The migrations, the backfill and the deploy

**0017** — `publications.asserted_by` alone: one nullable column, additive, no row
rewritten, nothing for `expectNoRowRewritten` to catch, and **no DDL the worker
depends on**, so `docs/self-hosting.md` §Upgrade's "worker first is always safe"
stays true, unamended. **0018** — the `content_items_status_check` rewrite
(`packages/db/src/schema/content-items.ts:71`, built from `CONTENT_STATUSES`),
then the backfill, which must run after the rewrite or violate a constraint not
yet widened. Next free tag is **0017**: `0010` is absent from `meta/_journal.json`
(`0009` → `0011`; head `0016_refine_proposals`) and must stay absent. The backfill
is `nextItemStatus`' third arm, transcribed:

```
update content_items ci set status = 'partially_published' where ci.status = 'approved'
and exists (select 1 from adaptations a where a.content_item_id = ci.id)
and not exists (select 1 from adaptations a
                 where a.content_item_id = ci.id and a.status not in ('published','failed'))
and exists (select 1 from adaptations a
             where a.content_item_id = ci.id and a.status = 'published')
and exists (select 1 from adaptations a
             where a.content_item_id = ci.id and a.status <> 'published')
```

`exists`, never `bool_and`/`bool_or`: the empty-adaptation guard is load-bearing
(`publish.repository.ts:1108` returns on `rows.length === 0`, and `bool_and` over
an empty set is `NULL`). Mid-delivery rows are excluded by construction — an item
with a `queued` half fails the `not exists` clause, and the worker's own recompute
answers correctly when it lands.

**`expectNoRowRewritten`** (`migrate.test.ts:279-300`, invoked `:978`) asserts no
pre-existing `content_items` value is rewritten from 0009 to head, and names
backfills as "precisely the class this test exists to catch"; it is green today
only because `seedEveryTable` (`:186-234`) seeds one `draft` item the predicate
cannot match. So the backfill's test is a **new `it` with its own seed**, the
stranded fan-out must **not** go into `seedEveryTable`, and the migration carries
a comment saying why this rewrite is the exception — or the next reader will "fix"
it.

**Rolling deploy.** Unchanged for the worker. Care is needed only at 0018: the
backfill makes `partially_published` reach api responses at once, and an old web
bundle renders `CONTENT_BADGE_STATUS[status]` as `undefined`
(`adaptations.ts:67`) plus a missing next-intl key. `docker compose up -d --build`
rebuilds everything together; anyone rolling services one at a time deploys **web
before the migration** — one paragraph in `docs/self-hosting.md` §Upgrade, beside
the worker-before-api rule this design leaves intact.

---

## 6. Tests

Nothing pins the gap today: `content.e2e.spec.ts:842` ("a rejected partial fan-out
is editable…") leaves the second adaptation **`queued`** (`:868-876`), so its
`:868` comment pins the one-published-one-still-queued case — correct behaviour,
not the gap; `publish.repository.spec.ts:1472` and `:1503` are likewise about
non-terminal siblings. Revision 1 nominated `:842` as "the test to change" and was
wrong; it is **unchanged** here, except that `:868` comment.

- `packages/shared/src/dto/content.test.ts` — new: `nextItemStatus` over its arm
  matrix, each arm failing alone when mutated; the empty array → `undefined`.
- `apps/worker/src/publish/publish.repository.spec.ts` — new, beside `:1472`:
  `seedFanOut(["publishing","queued"])` → `markPublished` → `markFailed` → item
  `partially_published`; the retry lands → `published`. One test per arm, the
  mirror that stops it being satisfied by deleting an arm the way `:1503` does,
  and `sweepAbandoned` over a mixed fan-out reaching the same verdict.
- `apps/api/src/content/content.e2e.spec.ts` — new: terminal mixed fan-out reads
  `partially_published`; `PATCH :id` 200s with no reject; a second approve
  re-queues ONLY the failed adaptation; `?status=partially_published` lists it;
  **reject 409s**; approve with an unknown half enqueues the failed halves and
  skips the unknown one; approve whose only target is unknown 409s
  `delivery_outcome_unknown`; both resolver verdicts, each followed by the approve
  that now works and each promoting the item; a second call on the row just
  settled 409s `delivery_outcome_already_known`; the resolver on a queued row
  answers `adaptation_pinned_queued`; the DTO carries `assertedByName`.
- `packages/db/src/migrate.test.ts` — two new `it`s, each with its own seed (§5).
  (i) A stranded fan-out seeded at the 0017 schema via `migrationsFolderBefore`
  (`:336`, precedent `:946-987`): the mixed item becomes `partially_published`,
  the one-published-one-queued item does not, an item with no adaptations does
  not. (ii) **The one-definition ratchet, in this file** because only the db tier
  has a database: every multiset over the six `ADAPTATION_STATUSES` up to two
  adaptations (6 + 21), plus every multiset of size three over `{published,
  failed, queued}` (10) — 37 items and the empty set — seeded, then the backfill's
  predicate and `nextItemStatus` run over the same rows and asserted equal on
  each. `schema-invariants.test.ts` cannot host it: it never queries Postgres
  (`:462-530` is a regex over `migrations/*.sql`). It also catches the
  `exists`-vs-`bool_and` empty-set trap by construction.
- `packages/db/src/schema-invariants.test.ts` — the CHECK matches
  `CONTENT_STATUSES` both ways (`:79`, `:97`) with the new value; nothing for
  `asserted_by`, a nullable FK with no enum and no CHECK.
- Web (`messages-parity.test.ts` for the keys ×4): the queue draws a
  `partially_published` card with the danger title and a Try again link; Reject is
  disabled when any adaptation is published; the Publish-now label counts only
  `failed` outcomes; an asserted delivery renders the "marked as delivered by"
  sentence instead of `linkUnavailable`.

Mutation testing per `docs/mutation-testing.md` on the three verdict arms, the
"any published" reject gate, and the per-row unknown skip.

---

## 7. Out of scope

The other #13 follow-ups (queue pagination/N+1, reconciliation beyond
`sweepAbandoned`, `format`/`disableLinkPreview`, the staleness bound,
`createQueue`); the residual duplicate-send window; a per-channel Retry control
(item-level Publish now already retries exactly the failed halves); notifications
of any kind; an `abandoned` adaptation status (§4.2).

---

## 8. Tasks

Ordered; each is one commit.

| Task | Ships alone? | What its pair owes it |
|---|---|---|
| T1 — `unknown` refusal + resolver | **yes**, and strictly better than today | nothing; it IS the pair the first review demanded |
| T2 — the status | **no** | T3's minimum rides in T2 or the build is red: the `CONTENT_BADGE_STATUS` entry (`apps/web/src/lib/adaptations.ts:67`) and `Content.status.partially_published` in `apps/web/messages/{en,es,ru,pt}.json` |
| T3 — the rest of the web | **no** — it does not type-check before T2 | T2's value in `CONTENT_STATUSES`, **and `@pubrick/shared`'s `dist` rebuilt** (`CLAUDE.md:323-327`): `GROUP_STATUSES` is `readonly ContentStatus[]` (`content/page.tsx:48`) and `:410`'s flag compares against `ContentStatus` |
| T4 — docs and CHANGELOG | last by construction | nothing depends on it |

**T1 — the `unknown` refusal and its resolver (api + web + migration 0017).**
*Files:* `packages/db/migrations/0017_*.sql`, `db/src/schema/content-items.ts`
(`asserted_by`), `shared/src/dto/errors.ts` (two codes),
`shared/src/dto/content.ts` (`nextItemStatus`, `assertedByName`/`assertedAt`),
`apps/api/src/content/content.{controller,repository}.ts`,
`apps/worker/src/publish/publish.repository.ts` (call `nextItemStatus`; amend the
`:405-420` and `:1078-1081` docstrings),
`apps/web/src/app/[locale]/content/[id]/page.tsx`, `apps/web/src/lib/api.ts`,
`apps/web/messages/*.json`.
*Steps:* migration (the column alone) → `nextItemStatus` in shared with today's
two verdicts, the worker's recompute calling it → `ADAPTATION_COLUMNS` grows the
asserted-by join → resolver route after `lockAdaptations`, outcome read **under
the adaptation row lock**, both verdicts, then the parent lock and the promotion →
pinned-code refusals → approve's per-row skip and empty-target refusal → two 409
codes ×4 locales → two buttons on an `unknown` row only, and the "marked as
delivered by" sentence.
*Tests:* §6's shared unit test, the resolver and approve e2e, a worker spec
proving the recompute still yields today's two verdicts through `nextItemStatus`.
*Mutations:* per-row skip → per-item; drop `asserted_by` (killed by the DTO field
and the sentence); empty-target refusal → 200; resolver accepting a known-outcome
row; the outcome read hoisted above the row lock.
*Agent:* a checkout-isolated api agent (it touches the worker at one call site and
two docstrings).

**T2 — the status (shared + migration 0018 + api gate + T3's minimum).**
*Files:* `shared/src/dto/content.ts`, `packages/db/migrations/0018_*.sql`,
`packages/db/src/*.test.ts`, `apps/worker/src/publish/publish.repository.ts`
(docstring), `apps/api/src/content/content.repository.ts`
(`EDITABLE_ITEM_STATUSES`, the reject gate), `apps/web/src/lib/adaptations.ts`,
`apps/web/messages/*.json`.
*Steps:* insert the value after `approved` → the third arm in `nextItemStatus` →
CHECK rewrite → backfill after the rewrite → reject gate on "any adaptation
published" → the badge colour and the four locale strings.
*Tests:* §6's worker spec, the shared test's third arm, both new
`migrate.test.ts` `it`s, schema-invariants, the api e2e for reject 409 and
edit-without-reject.
*Mutations:* each of the three arms; `exists` → `bool_and`; backfill before the
CHECK; reject gate back to the item's own status.
*Agent:* a db+worker agent in its own checkout; its PostgreSQL suites must be
serialised against any other agent using the same test database.

**T3 — the web (sections, flag, labels, gates).** *Files:*
`apps/web/src/app/[locale]/content/page.tsx`, `…/content/[id]/page.tsx`,
`apps/web/messages/*.json`. *Steps:* the `GROUP_STATUSES` hoist (§4.1) → `:410`'s
flag → the edit sentence (§4.3) → the Publish-now plural (§4.4) → Reject disabled
on any published adaptation → four locale files. *Tests:* §6's web list;
messages-parity. *Mutations:* drop the status from `:410`'s flag; append rather
than hoist in `GROUP_STATUSES`; count unknown rows in the Publish-now label.
*Agent:* a web-only agent in its own checkout, started after T2 lands.

**T4 — docs and CHANGELOG.** *Files:* `docs/specs/README.md` (the row),
`docs/self-hosting.md` (§Upgrade's web-before-migration paragraph),
`docs/lock-order.md` (the resolver's path), `CHANGELOG.md` (`Added`: the resolver;
`Changed`: the status and what the queue now says; `Fixed`: the unknown re-send).
*Tests:* none beyond the existing docs checks. *Agent:* a docs agent in its own
checkout.
