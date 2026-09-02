# Lock order

**One order, for the whole product:**

```
brands  →  adaptations  →  channels  →  content_items
```

Every transaction that takes row locks on more than one of these tables takes
them in that order. A transaction that needs only some of them skips the rest;
it never goes backwards.

Referenced from `apps/api/src/channels/channels.repository.ts`,
`apps/api/src/brands/brands.repository.ts`,
`apps/worker/src/publish/publish.repository.ts` and
`apps/api/src/content/content.repository.ts`. If you add a lock, add it here.

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
  exactly that, and lock *every* adaptation they will destroy — not only the
  ones whose queue jobs they are about to cancel, because it is the rows outside
  that filter that produced the measured deadlock.
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

## Same table, two transactions: `ORDER BY id`

A single statement touching several rows of one table locks them in whatever
order it scans them — for a bulk `UPDATE ... WHERE`, that is heap order, which
has nothing to do with id order and reverses freely as rows are updated. Two
transactions walking the same set in opposite orders deadlock each other.

So: **every multi-row lock over `adaptations` is taken in ascending `id`.**
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

## The two cycles this order closes

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
