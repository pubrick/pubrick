# Lock order

**One order, for the whole product:**

```
brands  →  pipeline_runs  →  adaptations  →  channels  →  content_items
```

Every transaction that takes row locks on more than one of these tables takes
them in that order. A transaction that needs only some of them skips the rest;
it never goes backwards.

Referenced from `apps/api/src/channels/channels.repository.ts`,
`apps/api/src/brands/brands.repository.ts`,
`apps/worker/src/publish/publish.repository.ts`,
`apps/api/src/content/content.repository.ts` and
`apps/worker/src/generate/generate.repository.ts`. If you add a lock, add it
here.

## Why this file exists rather than a comment at each site

Both deadlocks below were written by people who documented their lock order
carefully — each against a *different* counterparty, and each silent about the
third table its own statements touched. `ChannelsRepository.delete` justified
"channel first, then adaptations" against `ContentRepository.create` and never
mentioned the publish worker. The worker's terminal writes enumerated
"adaptations then content_items" and never mentioned that their own insert into
`publications` takes a foreign-key lock on `channels`. Both comments were true.
Neither was complete, and two true half-statements are how a cycle gets built by
people who are each being careful.

A lock order is a property of the whole product. It cannot be stated correctly
in a comment that can only see one side.

## What counts as taking a lock

Not just `SELECT ... FOR UPDATE`. All of these acquire row locks, and every one
of them has been overlooked in this codebase at least once:

- **`UPDATE` and `DELETE`** take `FOR UPDATE` on every row they touch — in scan
  order, unless you make the order deterministic yourself (see below).
- **An `INSERT` takes `FOR KEY SHARE` on every row its foreign keys reference.**
  That is a real lock that conflicts with `FOR UPDATE`: an insert into
  `publications` locks a row in `adaptations` *and* a row in `channels`, in the
  order the constraints were created. `content_versions` does the same to
  `content_items` and `adaptations`.
- **A cascade acquires locks in its own scan order**, invisibly. `DELETE FROM
  brands` reaches `channels`, `content_items`, `adaptations` and
  `pipeline_runs`; `DELETE FROM channels` reaches `adaptations`. So the rule for
  a cascading delete is: **lock everything the cascade will destroy, in the
  canonical order, before you issue the delete.** Both deletes in the api do
  exactly that, and lock *every* adaptation they will destroy — and, for the
  brand delete, *every* pipeline run — not only the ones whose queue jobs they
  are about to cancel, because it is the rows outside that filter that produced
  the measured deadlock, twice.
- **A `BEFORE DELETE` trigger** runs inside the deleting statement, holding
  whatever that statement has already locked. `publications_stamp_deleted_channel`
  writes `publications` rows while holding the `channels` row.

## Two tables the order does not name, and why

**`publications`** is not in the list because it is never taken on its own: a
claim or a receipt is only ever written under the lock of the adaptation it
belongs to. The one exception is the delete trigger above, which holds the
channel — and the canonical order already puts every adaptation of a channel
*before* that channel, so the two can never wait on each other.

**`organization`** sits above everything (a tenant delete cascades into all of
it) and is never taken together with anything else by application code.

## `pipeline_runs`, and why it sits second

It used to be in neither the list nor this document's silence about it — named
only as one of the two tables in an open cycle. It is in the order now, between
`brands` and `adaptations`, because two transactions take it together with the
rest:

- `GenerateRepository.finish` takes the run `FOR UPDATE` as its fence, and goes
  on to lock `channels` and — through the `content_items` insert's foreign key —
  `brands`.
- `DELETE FROM brands` cascades into it.

**Second, not first**, and that placement is the whole of the choice. The
alternative was to put the run ahead of the brand and have the brand delete lock
its runs before locking the brand, and it does not work: a run is inserted with a
foreign key to `brands`, so it is the brand's `FOR UPDATE` that stops new runs
from appearing. Lock the runs first and a run created in the gap between the two
statements is outside the lock set, unlocked, and reachable by the cascade out of
order — the same shape as the `adaptations` bug, rebuilt. Locking the root of the
cascade first is what makes "everything the cascade will destroy" a fixed set at
all, which is why the order starts at `brands` and why the run goes after it.

`finish` therefore takes `brands FOR KEY SHARE` explicitly as its first
statement. That is the same lock its `content_items` insert would take four
statements later anyway; taking it up front is what puts the terminal write in
the canonical order. Its fence is unmoved — the run is still locked and
re-checked before any write.

## Same table, two transactions: `ORDER BY id`

A single statement touching several rows of one table locks them in whatever
order it scans them — for a bulk `UPDATE ... WHERE`, that is heap order, which
has nothing to do with id order and reverses freely as rows are updated. Two
transactions walking the same set in opposite orders deadlock each other.

So: **every multi-row lock over `adaptations` or `pipeline_runs` is taken in
ascending `id`.** `BrandsRepository.delete` is the only statement that locks
many runs at once, and it does so `ORDER BY id FOR UPDATE`; nothing else may
walk that set in another order.
`ContentRepository.lockAdaptations` does it with `ORDER BY id FOR UPDATE`. Both
api deletes do. `PublishRepository.sweepAbandoned` is a bulk `UPDATE`, which
cannot carry an `ORDER BY` of its own, so it takes its locks in a
`WHERE id IN (SELECT ... ORDER BY id FOR UPDATE)` sub-select and repeats its
predicate on the outer statement.

That last part is load-bearing twice over. The sub-select's `FOR UPDATE`
re-evaluates its own `WHERE` after acquiring each row lock, and the outer
`UPDATE` re-evaluates the predicate again — so a row a live attempt has just
renewed still fails the second look and is not swept, which is the property the
sweep's safety rests on.

## The first two cycles this order closed

Both were reproduced against a real database (`40P01`, `deadlock detected`)
before the order existed, and both are regression-tested now.

**`channels`/`adaptations`.** `DELETE /api/channels/:id` took the channel
`FOR UPDATE` and then its adaptations. The publish worker's terminal write takes
the adaptation (`UPDATE adaptations`) and then, inserting the attempt's outcome
into `publications`, takes `FOR KEY SHARE` on the channel for the foreign key.
Channels→adaptations against adaptations→channels, and `FOR UPDATE` conflicts
with `FOR KEY SHARE`. `DELETE /api/brands/:id` reached `channels` the same way,
through the cascade at the end of its transaction, and deadlocked against any
adaptation its outstanding-only lock set had not covered.

**`adaptations` against itself.** `sweepAbandoned` was one bulk `UPDATE` with no
`ORDER BY`, locking in heap order, against `lockAdaptations`' ascending id — so
`POST /api/content/:id/reject`, on an item with two adaptations whose heap order
happened to reverse their id order, raced the sweeper into a deadlock and one of
the two died.

## The third cycle, and how the order closed it

`GenerateRepository.finish` against `BrandsRepository.delete`. Reproduced as
`40P01` on a real database on 2026-09-05, closed the same day.

The two acquisition sequences it had, from the statements:

```
finish          pipeline_runs FOR UPDATE  →  channels FOR KEY SHARE
                →  brands FOR KEY SHARE (the content_items INSERT's FK)

brands.delete   brands FOR UPDATE  →  adaptations FOR UPDATE
                →  DELETE FROM brands, whose cascade reaches
                   channels, content_items AND pipeline_runs
```

`finish` held the run and the channel and then asked for the brand;
`brands.delete` held the brand and then asked for the run and the channel. Two
independent cycles, each reproduced on its own with the other's lock removed:

- **`pipeline_runs`** — `CONTEXT: while deleting tuple in relation
  "pipeline_runs"`, inside `DELETE FROM ONLY "public"."pipeline_runs" WHERE
  $1 = "brand_id"`.
- **`channels`** — `CONTEXT: while locking tuple in relation "channels"`,
  inside `DELETE FROM ONLY "public"."channels" WHERE $1 = "brand_id"`.

Either side could be the victim. With the delete arriving second, the delete died
and `DELETE /api/brands/:id` was a 500. With the delete arriving first, `finish`
died inside the foreign-key check — `SELECT 1 FROM ONLY "public"."brands" x
WHERE "id" = $1 FOR KEY SHARE OF x`.

**The two FK locks alone were not it**, and this is the part a derivation from
the inserts gets wrong. `content_items.brand_id` → `brands` runs BEFORE
`adaptations.channel_id` → `channels`, which is the canonical direction. Run
without the `pipeline_runs` and `channels` pre-locks, the same interleaving
produces no deadlock at all: `finish` waits for the delete to commit and then
fails cleanly on `content_items_brand_id_brands_id_fk`. It was the two rows
locked *before* the insert — both of them rows the brand's cascade destroys —
that turned a wait into a cycle. The lock that closed the loop was the one nobody
wrote: a foreign key's `FOR KEY SHARE` on the parent, four statements after the
statement that made the transaction vulnerable.

**Now:** `finish` takes `brands FOR KEY SHARE` first, and `brands.delete` takes
every one of the brand's runs `FOR UPDATE ORDER BY id` second, where the order
says. The two transactions can now only meet on `brands` — one holding it, the
other waiting on it — and never each holding what the other asks for next.

**What a run whose brand is deleted mid-flight does now.** It ends as `gone`, the
outcome `FenceOutcome` already defines for exactly this, logged in one line: the
brand lock returns no row, and the run's own row went with it (`pipeline_runs.brand_id`
is `on delete cascade`). It was never going to produce a draft — `content_items.brand_id`
has nowhere to point once the brand is gone — so what changed is not whether the
run survives but whether it dies cleanly. What it spent is not lost with it:
ledger rows are written per call in their own transactions, and
`usage_ledger.run_id` is `on delete set null` so the org's spend-to-date still
sums correctly over a run that no longer exists.

Every other pair among these five transactions was re-run after the change and
does not deadlock: `finish`×`ChannelsRepository.delete`,
`finish`×`ContentRepository.create` (`FOR KEY SHARE` against `FOR KEY SHARE` —
taken in opposite orders and never in conflict), `finish`×`approve`,
`finish`×`reject`, `brands.delete`×`channels.delete`, `brands.delete`×`approve`,
`brands.delete`×`reject`, `channels.delete`×`approve`, `channels.delete`×`reject`,
and `approve`×`reject`.

## The price of the order, stated rather than hidden

Taking adaptations before the channel means the api's channel delete no longer
holds the channel while it reads them, and the channel's `FOR UPDATE` was what
used to block a concurrent `ContentRepository.create` from inserting a new
adaptation for it (that insert takes `FOR KEY SHARE` on the channel).

This is not recoverable: the only lock mode that blocks the create is exactly
the one the worker needs, so any lock that closes that window re-opens the
cycle. What is left is a narrow one — a *new* content item created **and**
approved between the delete's lock set and its cascade, since
`adaptations_one_live_per_item_channel` forbids a second live adaptation for an
(item, channel) pair that is already in the set — and its cost is a pg-boss job
for an adaptation the cascade removed. That job wakes, finds no row and returns.
It is the "queue claims work for something that does not exist" untidiness both
deletes were written to reduce, not a lost or duplicated post. `BrandsRepository.delete`
has always had this window, for the same reason: nothing locks a brand on the
create path.
