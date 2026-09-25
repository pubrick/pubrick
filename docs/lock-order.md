# Lock order

**One order, for the whole product:**

```
brands  →  pipeline_runs  →  adaptations  →  channels  →  content_items  →
refine_proposals / adaptation_proposals
```

Every transaction that takes row locks on more than one of these tables takes
them in that order. A transaction that needs only some of them skips the rest;
it never goes backwards.

The dated-topic planner, topic edits, and manual calendar writers serialize on
the brand row with `FOR NO KEY UPDATE` before touching topics or calendar slots.
This is compatible with the `FOR KEY SHARE` lock taken by generation's brand
foreign key after it has locked a slot or topic. The worker then locks
its config and topic rows in stable ID order before checking the day's slots.
This makes the daily cap and linked-topic check atomic across worker replicas
and manual placement. Removing a linked slot holds the brand lock while
clearing the topic's target date, so the next scan does not undo the editor's
removal.

Content archive and restore lock all of an item's adaptations by ID before
locking `content_items`, then change only the parent status. Archive refuses
active delivery rows. The publish worker's `markPublishing` locks its adaptation
before reading and locking the parent, so a job fetched before archive cannot
claim a send after archive has committed. Worker status recomputation keeps an
archived parent unchanged.

Moving one channel's scheduled time locks only its adaptation, then reads its
item and receipts before changing its queue job. It never locks the item first.
The worker's claim waits on that adaptation lock and checks `scheduled_at` as
well as status, so an old job fetched before a move cannot send at the new slot.
The cancelled job, adaptation update, and replacement job share one transaction.

Permanent deletion of an archived unsent post takes the same ordered adaptation
locks before the content item lock. It refuses any delivery attempt or linked
publication record, a retained generation run, or an item whose durable safety
marker is false before deleting it. A trigger on adaptation deletion remembers
delivery history that would otherwise lose its item link when a channel is
deleted. Historical posts have the marker false because prior orphaned receipts
cannot be matched back to a post.

Daily topic suggestions also serialize admission on `brands`. Both the manual
`TopicsRepository.requestSuggestions` path and the automatic
`SuggestionsScanService.trigger` path take that brand row `FOR NO KEY UPDATE` before
checking the 30-minute request cooldown. The automatic path then locks its
`autopilot_configs` row and inserts the request and queue job in the same
transaction. This order prevents simultaneous manual and automatic admissions
from each missing the other's new request.

Telegram account sign-in has a separate workspace-scoped lock chain:
`member` → `telegram_login_attempts` → `telegram_source_accounts`.
The final verified-session replacement and disconnect recheck the actor's
owner/admin membership under a row lock, then lock or update the organization's
login attempt, then write its account row. The phone and verification admission
updates touch only the attempt row; no transaction holds a database lock during
an MTProto network call. A disconnect invalidates a pending verification before
deleting the account, so a late Telegram response cannot reconnect it.

Brand access replacement has its own short chain: `brands` → `member` →
`brand_access`. Replacing one brand's grants locks its brand row `FOR UPDATE`,
then the selected member rows by ID `FOR KEY SHARE`, then deletes and inserts
grant rows. A member role update holds that member row first and its trigger
deletes the member's grants. The trigger does not ask for a brand row, so it
cannot close a cycle with replacement waiting on that member. Brand deletion
cascades into grants after holding the brand; it never asks for a member row.
Keep future grant writers on this order, and do not add a brand lookup or lock
inside the role-change trigger.

Channel re-adaptation stages its proposal after the model returns. The stage
transaction locks its adaptation, then its item, then replaces the proposal.
Accept takes the same two parent locks before reading the proposal and writing
an AI version. Discard only deletes the proposal. The proposal's composite
foreign key also checks that its adaptation belongs to its content item.

Inline image replacement locks the organization `FOR KEY SHARE` before its
`content_items` row, matching tenant deletion's outer-to-inner cascade. It
then checks the whole-set revision, locking selected image assets
`FOR KEY SHARE` in ID order,
and replacing `content_image_slots`. The revision increments in that same
transaction, so a stale editor receives a 409 before deleting any slot. Body
edits, version restoration, refine acceptance, and approval already serialize
on that same item lock; the body update trigger prevents any writer from
leaving an image beyond the last paragraph. Slot inserts also take
`FOR KEY SHARE` on referenced `media_assets` rows.
Regenerating one saved inline image checks the organization and item under
`FOR KEY SHARE` before calling Gemini. It holds no database lock during the
provider call. Afterward, a short transaction locks the organization
`FOR KEY SHARE`, item `FOR UPDATE`, and new media asset `FOR KEY SHARE`, then
updates the selected slot. It rechecks the item's state, image revision, and
slot identity under those locks. If any changed, the generated asset remains
in the media library and the slot stays untouched.
Media deletion checks cover, inline, and public feed references, then deletes
the asset; its foreign-key fallback turns a concurrent attachment into a 409.
It never takes a content-item row lock after touching media, so this path cannot
reverse the item-to-media acquisition order. Feed snapshot insertion references
its feed entry and media asset but never takes an item lock afterward.
Brand deletion locks its runs and adaptations in the canonical order, then all
brand items in ID order before clearing feed snapshots and inline slots. This
waits for any editor or feed publisher holding an item and prevents a new
snapshot or slot from arriving after cleanup; the subsequent brand cascade can
delete its media while direct media deletion remains blocked by the
slot-to-media `NO ACTION` foreign keys.

Telegram publication comment refresh takes an organization `FOR KEY SHARE`
lock, then a brand `FOR KEY SHARE` lock before the live adaptation, channel,
content item, and publication receipt in that order. It then claims its sample
row and enqueues the workspace-serialized Telegram comments job in one
transaction. The worker uses the same order before
locking the sample `FOR UPDATE` and replacing its bounded reply rows. This
keeps organization and brand deletion cascades from waiting on a sample while
the worker waits for either parent. It also makes a concurrent channel delete
finish before the live check or wait for the short sample write. Public Telegram reads happen
outside the transaction; the worker rechecks the live publication before
writing and matches the job's request timestamp, so a stale read cannot
overwrite a later sample. The receipt lock follows the channel lock because
channel deletion stamps that receipt in a trigger.

Automatic Telegram reply collection uses the same parent-first order at its
final write: organization, brand, then source and story for a news sample, or
adaptation, channel, item and publication receipt for an owned post. It checks
the collection config revision under a row lock only after the live target is
locked. Opt-out therefore wins before a final write or waits for it; neither
path can hold the config while waiting for a target that deletion already
holds. The Telegram network read remains outside the transaction.

Paid comment analysis admission has a short organization-scoped transaction:
it locks `organization FOR NO KEY UPDATE`, expires any stale active admission
for the target, counts the previous rolling hour's admissions across source
items and publication replies plus pre-admission ledger calls, and inserts one
reservation. All cutoffs use the database clock. This lock makes
the ten-call budget atomic across API replicas. The provider call runs only
after commit. Usage ledger inserts and the final admission completion are
separate single-table writes; neither holds an admission lock while asking
for an organization or brand lock. A stale lease can be closed and replaced
after two minutes without releasing its original hour's budget.
Both analysis save paths recheck the original sample timestamp after the paid
call. Publication analysis also checks the collection request timestamp and
locks organization, brand, adaptation, channel, item, receipt, then sample.
Source analysis locks organization, brand, source, then news item before saving;
it discards a result if the worker replaced that item's reply sample.

Referenced from `apps/api/src/channels/channels.repository.ts`,
`apps/api/src/brands/brands.repository.ts`,
`apps/api/src/ai-credentials/ai-credentials.repository.ts`,
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
  brands` reaches `channels`, `content_items`, `adaptations`, `pipeline_runs`
  and — through `content_items` — `refine_proposals`; `DELETE FROM channels`
  reaches `adaptations`. So the rule for a cascading delete is: **lock everything the cascade will destroy, in the
  canonical order, before you issue the delete.** Both deletes in the api do
  exactly that, and lock *every* adaptation they will destroy — and, for the
  brand delete, *every* pipeline run — not only the ones whose queue jobs they
  are about to cancel, because it is the rows outside that filter that produced
  the measured deadlock, twice.
- **A `BEFORE DELETE` trigger** runs inside the deleting statement, holding
  whatever that statement has already locked. `publications_stamp_deleted_channel`
  writes `publications` rows while holding the `channels` row.

## Four tables the order does not name, and why

**`publications`** is not in the list because it is never taken on its own: a
claim or a receipt is only ever written under the lock of the adaptation it
belongs to. The one exception is the delete trigger above, which holds the
channel — and the canonical order already puts every adaptation of a channel
*before* that channel, so the two can never wait on each other.

That "only ever written under the lock of the adaptation it belongs to" now has
a writer in the OTHER process, and it holds to it. `ContentRepository.
assertDelivery` — the api's resolver for a delivery whose outcome nobody knows —
takes the adaptation row `FOR UPDATE`, updates it, inserts the receipt (whose
foreign keys take `FOR KEY SHARE` on `channels`, and on `user` for
`asserted_by`), and only then locks `content_items` to promote the item. That is
`markPublished`'s own sequence, `adaptations` → `channels` → `content_items`, so
it adds no acquisition this order did not already have and no edge: a resolver
and a landing delivery on one adaptation serialise on the adaptation row, which
`content.e2e.spec.ts` proves against a real database under *"settling a delivery
nobody can speak for"*. `user` is not in the order for `organization`'s reason —
an implicit `FOR KEY SHARE` on a row nothing else holds while asking for
anything, conflicting only with a delete of the account itself.

**`organization`** sits above everything (a tenant delete cascades into all of
it). Most inserts carrying an `org_id` foreign key acquire an implicit
`FOR KEY SHARE` lock on that row. Inline image replacement and Telegram
publication comment refresh/worker writes also take it explicitly, before
`brands` or any other row they lock. This order matters: taking a brand or
sample first and then reaching the organization through a foreign key could
deadlock with a tenant delete, which locks the organization before cascading
to either child. `FOR KEY SHARE` conflicts with the tenant delete but allows
independent writers in the same organization to proceed concurrently.

Approve and Reject also append prompt decision evidence. They take the
organization's `FOR KEY SHARE` lock before adaptation and item locks so the
event's organization foreign key adds no late edge. Historical run, revision,
and item IDs in the event deliberately have no foreign key: the path reads the
producing run and revisions without locking them after the item, and the
journal survives deletion of those records.

**`ai_credentials`** IS taken together with a table in the order, and is named
here rather than left silent. `AiCredentialsRepository.delete` locks the key rows
(the `DELETE ... RETURNING`) and then, in the same transaction, the org's queued
`pipeline_runs`. It is left out of the order because nothing takes those two the
other way round — the credential rows are only ever reached by that endpoint and
by plain reads. That is the same standing the `channels`/`adaptations` edge had
before it became the first cycle this file records, so if a second writer of
`ai_credentials` ever appears, put it in the order rather than re-deriving this
paragraph.

**`usage_ledger`** is not in the list either, and its absence used to be
unexplained rather than decided. Every ledger insert takes `FOR KEY SHARE`
through its foreign keys — on `pipeline_runs`, `channels`, `content_items` and
`adaptations`, three of which the order governs — but no transaction ever holds
a ledger row while asking for anything else: the row is written in a
transaction of its own, containing that one insert, both in the worker
(`GenerateRepository.recordUsage`, deliberately outside the step's checkpoint so
a dying run still records what it spent) and in the api
(`ContentRepository.recordRefineUsage`, and `AiCredentialsRepository`'s Test).
A transaction that took a ledger insert together with a lock on any of those
four tables would be a new acquisition sequence and would belong in the order;
none does today.

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

## `refine_proposals`, and why it sits last

It is in the order rather than in the list above, and the earlier claim that it
could stay out of the order — "the only transaction that touches it takes
nothing else in the order except the row its own foreign key reaches, and
`content_items` is last, so this cannot invert anything" — was wrong twice over.
Being last protects a transaction whose *other* locks are all in the order; a
table **outside** it, taken **before** `content_items`, is a new acquisition
sequence, which is exactly what the `usage_ledger` paragraph above says belongs
in the order. And "the only transaction" was never true: the proposal row is
written by four transactions.

The three that lock more than it, all of them taking `content_items` first:

- **`ContentRepository.insertProposal`** locks the item, deletes the draft's
  existing proposal row and inserts the new one. It takes the item explicitly,
  as its first statement, rather than leaving it to the insert's foreign key
  four statements later — that is the whole of the fix, and without it the order
  is the inverse.
- **`DELETE FROM brands`** cascades into `content_items` and, from there, into
  the `refine_proposals` rows of every draft it destroys. Structurally in that
  order: the child rows can only be reached by the statement that has already
  deleted — and so locked — the parent.
- **`ContentRepository.acceptRefine`** takes `content_items FOR UPDATE` through
  `requireEditableItem` and reads and deletes the proposal row under it. Every
  other write it makes — the body `UPDATE`, and the `content_versions` insert
  whose foreign key takes `FOR KEY SHARE` on that same item — touches a row it
  already holds in a strictly stronger mode, and it files nothing against an
  adaptation, which is the one thing `recordHumanVersion` warns would invert
  this order. With one row named rather than left out, because a *true half-
  statement* is what this file's own preamble says builds cycles: that version
  insert also takes `FOR KEY SHARE` on **`organization`** through `org_id`
  (`packages/db/src/schema/generation.ts`), which this transaction does not
  already hold. Nothing is wrong — the exemption above says why an implicit
  `FOR KEY SHARE` on `organization` closes no cycle — but the sentence is now
  complete.

**`ContentRepository.discardRefine` is the exception, and it is safe to be
one.** It is a single `DELETE` against `refine_proposals` and takes nothing
else: deleting a child row acquires no lock on its foreign-key parent (only an
insert or a key update does), so it never reaches `content_items` at all, in any
order. It holds one row for the length of one statement and can be neither half
of a cycle. It is also refused on no status, deliberately — a discard changes no
text, so a post an approval has pinned is exactly where a person must still be
able to clear a card whose Accept is refused.

Both of the deadlocks the inverse order produced were reproduced as `40P01` on a
real database, from both sides, and are regression-tested in
`content.e2e.spec.ts` under *"what a second transaction on the same draft does
to it"*. They cost more than a deadlock usually does: the staging transaction
opens *after* a model call that has already been paid for and its ledger row
written, and `40P01` is not `23503`, so the victim's reader was answered a 500
with no proposal.

**`BrandsRepository.delete` does not pre-lock `refine_proposals`, and must not.**
The rule for a cascading delete above is "lock everything the cascade will
destroy, in the canonical order, before you issue the delete", and the reason it
exists is a counterparty that reaches those rows out of order. There is none
here: the cascade already takes `content_items` before the proposal rows, and so
does every other transaction that touches them. Adding a pre-lock would *create*
the inversion it is meant to prevent — that delete does not lock `content_items`
at all (nothing else takes it out of order against the brand), so a
`refine_proposals` pre-lock would be the one statement in the product that took
the two backwards.

Three things about the staging transaction are load-bearing and easy to undo by
accident.

It opens **after** the model call has returned. The whole reason the editability
read earlier in `refine` is a plain `SELECT` and not `requireEditableItem`'s
`SELECT … FOR UPDATE` is that holding a row lock and a pool connection across a
forty-five-second call is pool exhaustion at exactly the concurrency it is meant
to permit.

Its lock on the item is **`FOR NO KEY UPDATE`**, and the mode is a decision, not
a default. `FOR KEY SHARE` — the mode the insert's foreign key would take anyway
— orders the acquisition and nothing else: two presses can hold it at once, both
delete a row neither can see, and the second is answered `duplicate key` by the
unique index, which is a 500 for a call the person has already paid for.
`FOR NO KEY UPDATE` is the weakest mode two holders cannot share, so overlapping
presses queue on the item and the later supersedes the earlier, exactly as two
sequential presses do. It is deliberately not `FOR UPDATE`: this transaction
changes no item, and `FOR NO KEY UPDATE` leaves the foreign-key `FOR KEY SHARE`
that `content_versions` and `usage_ledger` inserts take unblocked.

The delete is keyed on **`content_item_id` alone**, the unique index's own
column — the row the insert could collide with, and no narrower a predicate than
the constraint it has to satisfy. Adding `org_id` would not be stricter: tenancy
is checked before the call, against the item, and the proposal's `org_id` is
always that item's, so the two predicates select the same row. (An earlier note
here claimed the narrower delete would leave a row behind and turn a supersede
into a 500. It cannot, for that reason, and the mutation that adds `org_id`
survives the suite — an equivalent mutation, which is the evidence.)

## Same table, two transactions: `ORDER BY id`

A single statement touching several rows of one table locks them in whatever
order it scans them — for a bulk `UPDATE ... WHERE`, that is heap order, which
has nothing to do with id order and reverses freely as rows are updated. Two
transactions walking the same set in opposite orders deadlock each other.

So: **every multi-row lock over `adaptations` or `pipeline_runs` is taken in
ascending `id`.** All eight of them, and there is no ninth:

| statement | how it orders |
|---|---|
| `BrandsRepository.delete`, the brand's runs | `ORDER BY id FOR UPDATE` |
| `BrandsRepository.delete`, the doomed adaptations | `ORDER BY id FOR UPDATE` |
| `ChannelsRepository.delete`, the channel's adaptations | `ORDER BY id FOR UPDATE` |
| `ContentRepository.lockAdaptations` (`approve`, `reject`) | `ORDER BY id FOR UPDATE` |
| `AiCredentialsRepository.delete`, the org's queued runs | `WHERE id IN (SELECT … ORDER BY id FOR UPDATE OF r)` |
| `PublishRepository.sweepAbandoned`, the abandoned adaptations | `WHERE id IN (SELECT … ORDER BY id FOR UPDATE OF a)` |
| `PublishRepository.sweepStranded`, the `scheduled`/`queued` rows with no job | `WHERE id IN (SELECT … ORDER BY id FOR UPDATE OF a)` |
| `GenerateRepository.sweepAbandoned`, the abandoned runs | `WHERE id IN (SELECT … ORDER BY id FOR UPDATE OF r)` |

A bulk `UPDATE` cannot carry an `ORDER BY` of its own, which is why the last
four take their locks in a sub-select and repeat their predicate on the outer
statement. **The half that holds is the sub-select's**: its `FOR UPDATE`
re-evaluates its own `WHERE` against the new row version after acquiring each
row lock, so a row a live attempt — or a person's `reject` — renewed while the
sweep was parked on its lock drops out of the locked set and is never touched.
That is the property both sweeps' safety rests on. The outer `UPDATE`'s copy of
the predicate is belt, not the defence: removing it leaves the guarantee intact
(measured — the worker suite and a drive in which a `reject` commits under the
held lock both stayed green without it), and it is kept only because a statement
whose outer `WHERE` does not say what it writes is one the next reader has to
reconstruct out of a sub-select.

The sub-select can afford to be evaluated twice because it plans as an
anti-join, not as a per-row probe into the queue: `EXPLAIN ANALYZE` over a
seeded 2 000 live jobs gives `LockRows -> Sort -> Hash Right Anti Join` (a
sequential scan of `pgboss.job_common` filtered by `state < 'completed'`, hashed
against a scan of `adaptations`), 0.2-0.5 ms — measured twice, on the review's
seeded set and again here.

**A cascade does not need the treatment, because the pre-lock already gave it
one.** `DELETE FROM brands` reaches `pipeline_runs`, `adaptations`,
`channels` and `content_items` in its own scan order, unordered — but every row
it will destroy is a row the same transaction has already locked, in the
canonical order, statements earlier. It acquires nothing new, so it cannot be
half of a cycle. That is the entire reason the rule above is stated as "lock
everything the cascade will destroy, before you issue the delete" rather than
"order the cascade", which is not something SQL lets you do.

### The rule, and why the last two writers needed it

**A multi-row write to a table anyone locks in ascending `id` must take its own
rows in ascending `id` too.** Not only the `SELECT ... FOR UPDATE` walkers — a
bulk `UPDATE ... WHERE` is a multi-row lock, and an unordered one against an
ordered one is a cycle just as surely as two unordered ones.

This was learned the second time. When `pipeline_runs` entered the order, its
`BrandsRepository.delete` walk was given `ORDER BY id FOR UPDATE` and this file
said, wrongly, that nothing else locked many runs at once. Two statements did:
`AiCredentialsRepository.delete` failing the org's queued runs, and
`GenerateRepository.sweepAbandoned` failing every abandoned one. Both were bulk
`UPDATE`s with no ordering, both overlapped the delete's set, and both raced it
into `40P01` — measured, on a real database, racing the real statements:

| race | unordered | ordered |
|---|---|---|
| `brands.delete` × `ai-credentials.delete`, 3 queued runs (`MAX_CONCURRENT_RUNS`), 150 rounds | **30** (`DELETE /api/brands/:id` the victim 17×) | **0** |
| `brands.delete` × generate sweep, 60 runs, 40 rounds | **8** (4× each side) | **0** |

Note where that cycle lives: **inside one statement**. Two multi-row statements
disagreeing about row order deadlock while each is still executing, so no
interleaving of the two transactions' *statements* can produce it — a pair
matrix over statement prefixes, which is how the rest of this file was verified,
reports such a pair clean and always will. It is also why the runs' `ORDER BY id`
was left with a SURVIVED mutation and a note saying no counterparty existed. Two
did. Both regression tests now walk the set the other way:
`ai-credentials.e2e.spec.ts`, "fails those runs in ascending id order", and
`generate.service.spec.ts`, "sweepAbandoned locks in id order".

### Two tables nobody orders, and why they are still not a cycle

Both have more than one multi-row writer, and neither writer orders anything.
Named here so the next reader does not have to re-derive it.

**`publications`.** `PublishRepository.sweepOrphanedClaims` bulk-updates every
stale `in_flight` claim whose adaptation is gone; the
`publications_stamp_deleted_channel` trigger, inside `DELETE FROM channels`,
updates every publication of the channel it is destroying. Nothing takes
`publications` in `id` order, so there is no ordered walker for either of them to
disagree with — and **their sets cannot overlap**: the sweep's set is
`adaptation_id IS NULL`, and the only things that null that column are the two
cascades, each of which destroys the channel in the same statement that orphans
the claim. There is no state in which a publication has lost its adaptation and
still has a channel left to delete. If a third MULTI-ROW writer of this table
ever appears, or a caller starts walking it in `id` order, give both of these the
sub-select shape rather than re-deriving this paragraph. The api's delivery
resolver is not one: it inserts a single receipt, by construction under the lock
of the one adaptation it belongs to, so it has no row order to disagree about.

**`channels`.** `GenerateRepository.finish` takes `FOR KEY SHARE` on every
surviving channel of the run, unordered; `DELETE FROM brands`'s cascade takes
every channel of the brand, unordered, and `FOR KEY SHARE` conflicts with that.
They cannot meet: both transactions take the **brand** first — `finish` as
`FOR KEY SHARE`, the delete as `FOR UPDATE` — and those conflict, so whichever
arrives second is parked on the brand row holding no channel at all. The brand
lock is what keeps this pair out of the cycle, which is one more reason the order
starts there.

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

## The staleness bound takes no lock

`PUBLISH_MAX_LATENESS_HOURS` (worker, 2026-09-11) adds a comparison, not a
transaction. `load` reads `now() - scheduled_at` in a plain `SELECT` with no
`FOR UPDATE` and no join it did not already make; the refusal it can lead to is
`markFailed`, which is the terminal write the publish path already performed and
whose order — `adaptations` → the `publications` insert's `FOR KEY SHARE` on
`channels` → `content_items` — is unchanged and documented above.
`adaptations.failure_reason` rides along inside statements that already existed.

Stated rather than left silent, because "this change adds no lock" is exactly
the claim the two cycles at the top of this file were each built out of. The
next increment on this path does add an edge, and it is the section below.

## The stranded-delivery sweep, and the edge it adds

`PublishRepository.sweepStranded` (worker, 2026-09-12) ends every `scheduled`
or `queued` adaptation that no pg-boss job names any more — the row retention
deleted a waiting job out from under. It is a **multi-row writer of
`adaptations`, and it takes its rows in ascending `id`**, through the same
`WHERE id IN (SELECT … ORDER BY id FOR UPDATE OF a)` sub-select as its two
siblings in the table above, with its predicate repeated on the outer `UPDATE`
for the reason stated there. It acquires nothing else beyond what its sibling
already acquires: the `publications` receipt it writes takes `FOR KEY SHARE` on
`channels` through the foreign key, and `recomputeItemStatus` then takes
`content_items` — `adaptations` → `channels` → `content_items`, the canonical
tail, unchanged.

**The counterparty is new, and that is the whole of this entry.**
`sweepAbandoned` walks `publishing` rows, which `ContentRepository.reject` also
walks and which nothing else in the product re-approves. This candidate set is
walked by **`approve` as well**: `lockAdaptations(…, ["pending", "failed",
"scheduled"])` is approve's own ordered walk, and `reject`'s set
(`queued`/`scheduled`/`publishing`) overlaps it from the other side. So
`POST /api/content/:id/approve` — a person pressing Approve or Publish now — is
a counterparty this file has never had to consider for a sweep before, and an
unordered bulk `UPDATE` against its ascending walk is the same cycle
`sweepAbandoned` was measured producing against `reject`. Reproduced here too,
the same way and on a real database: with the `ORDER BY` removed, the sweep and
an approve-shaped ordered walk over two adaptations whose heap order reverses
their id order deadlock, and the sweep dies with `40P01`
(`publish.repository.spec.ts`, *"sweepStranded locks in id order, so it cannot
deadlock against approve's ordered lock"*).

**Two sweeps, two transactions, and never one.** `PublishService.sweepAbandoned`
runs the two passes one after the other rather than together, and that is a
lock-order decision rather than a style one. A single transaction sweeping
`publishing` rows and then `scheduled`/`queued` ones would take `adaptations` in
**two** ascending runs — every id of the first set, then ids that may be lower
from the second — against a `reject` that takes `queued`, `scheduled` AND
`publishing` in ONE ascending walk. Two ascending runs inside one transaction
are not an ascending walk, which is the whole content of the rule above. Kept
apart, they are two transactions that never hold each other's rows.
