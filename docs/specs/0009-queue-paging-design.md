# 0009 — Queue list: a bound on the page, and one query for its adaptations

Design for issue #15 (split out of #13). Design only; no code changes here.
Every claim about current behaviour carries a `file:line`. Numbers measured
2026-09-11 through the real HTTP route against a throwaway database
(`pubrick_3ad`, dropped afterwards) on the project's `pgvector/pg16` container,
on a loaded laptop.

## 1. Today

### The shape

`GET /api/content` is `ContentController.list`
(`apps/api/src/content/content.controller.ts:37-40`), behind `ActiveOrgGuard`
(`:33`), taking exactly one query parameter, `status`.

`ContentRepository.list` (`apps/api/src/content/content.repository.ts:750-781`):

1. `:764` — selects **every** item the org owns. No `LIMIT`, and **no `ORDER BY`
   at all**: card order is whatever the planner returned.
2. `:765-768` — `itemAiEvidence` (`:728-746`), one batched `IN` query for the
   item-level `ai` version rows. Already correct; its own docstring (`:711-714`)
   names the N+1 below and declines to add a second one.
3. `:769-780` — `items.map(async …)`, and inside it `:777`
   `adaptationsFor(orgId, item.id)` (`:694-703`): **one round trip per item.**

So **queries per request = 3 + N**, and **per item exactly one**. The other two
candidates are not queries: `bodyIsAiVerbatim` (`:776`) is computed in JS from
the batched evidence, and `aiVersionBodies` is `get()`-only (`:896-897`). That
one query is not free inside, though: `ADAPTATION_COLUMNS` carries two
correlated subqueries over `publications` — `externalUrl` (`:469-474`) and
`deliveryOutcome` (`:513-524`) — evaluated **per adaptation row**: four per
two-channel item, 2 000 for a 500-item response.

`ITEM_COLUMNS` (`:39-54`) includes `body` (`:43`); the browser's `ContentItem`
type does not (`apps/web/src/app/[locale]/content/page.tsx:97-110`), and
`deriveOrigin` needs only `origin`, `adaptations[].origin` and
`bodyIsAiVerbatim` (`apps/web/src/lib/origin.ts:78-90`). Every body is read,
serialised and shipped to draw a badge that never looks at it.

### The numbers

Seeded: one org, N items × 2 `pending` adaptations, one item-level `ai` version
row per item, ~684-character bodies. Statements counted by wrapping
`pg.Pool.prototype.query` in-process.

| N items | statements | response bytes | `body` share | wall (warm) |
|---|---|---|---|---|
| 500 | **503** | **774 722** | 342 326 (44 %) | **110 ms** (repeats 99 / 107 / 111) |
| 1 000 | **1 003** | **1 550 222** | 685 326 (44 %) | **271 ms** first, 212 / 326 / 237 on repeat |

`?status=draft` cost exactly the same (503 / 774 722 / 112 ms): the filter *is*
server-side (`content.repository.ts:756-763`), but every seeded item was a
draft. The target shape, emulated as raw SQL through the same pool — one keyset
page without `body`, one `= ANY(...)` for adaptations, one for versions:

| page size | statements | bytes | wall |
|---|---|---|---|
| 50 | **3** | **12 117** | ~5 ms |
| 100 | **3** | **24 217** | ~3 ms |

### The client

- **Status filter: server-side.** The chips (`page.tsx:481-484`, rendered `:542`)
  set `status`; `fetchContent` (`:190-194`) puts it in the URL.
- **Grouping: client-side.** `:477-479` buckets the response into the five
  `GROUP_STATUSES` sections (`:48-51`, failures first), so the *unfiltered* view
  needs every status in one response — the half a page bound changes the
  meaning of.
- **The poll re-fetches the whole list.** `usePoll` at `:195-199`, every
  `CONTENT_LIST_POLL_INTERVAL_MS = 5000` (`apps/web/src/lib/adaptations.ts:109`),
  slower on a hidden tab (`use-poll.ts:141`). It **settles** when nothing is in
  flight (`contentSettled`, `page.tsx:145-146`), so the 5 s bill is paid only
  while a post is publishing — exactly when the list is longest and the reader
  is watching. Plus `refreshContent()` when a run leaves the open list
  (`:230-236`).

### What breaks first at 1 000 items — not wall time (0.2 s local, warm)

1. **The pool.** `createDb` builds a default `pg.Pool`
   (`packages/db/src/client.ts:8-9`) — max 10 clients — shared with better-auth
   and every other repository. `Promise.all` over 1 000 `adaptationsFor` calls
   (`:769-780`) queues a thousand statements against those ten; one queue open
   in one tab degrades every other request in the api for the duration.
2. **Bandwidth.** 1.55 MB × one poll per 5 s per tab ≈ **1.1 GB/hour/tab** while
   anything is publishing — the same arithmetic that got `material` cut out of
   the runs list (`runs.repository.ts:77-82`: 122 265 B, ~85 MB/hour), one order
   of magnitude worse.
3. **The render.** 1 000 cards rebuilt from a fresh array every 5 s.
4. **Order.** With no `ORDER BY` (`:764`) the page is planner order today; the
   moment there is a `LIMIT`, "which items" becomes a correctness question.

## 2. Options

### (a) Keyset pagination + batched adaptations

`?limit=&cursor=`; cursor is `(created_at, id)` encoded, `ORDER BY created_at
DESC, id DESC`, `WHERE (created_at, id) < (…)`; server-side `status` unchanged.
One `WHERE content_item_id = ANY($ids)` for the page's adaptations (`inArray`,
exactly what `itemAiEvidence:735-741` already does), grouped in JS;
`ADAPTATION_COLUMNS` with both `sql` templates reused unchanged, so
`deliveryOutcome` and `externalUrl` keep their single definition. `body` leaves
`ITEM_COLUMNS` for the list — a second, slim allowlist beside it, the move
`RUN_LIST_COLUMNS` vs `RUN_DETAIL_COLUMNS` already made
(`runs.repository.ts:94-97` / `:99-115`). Needs an index on `(org_id,
created_at DESC, id DESC)`; today there is only `content_items_org_id_idx`
(`packages/db/src/schema/content-items.ts:62`).

**"Load more", not numbered pages.** The constitution's "one place" rule
(`CLAUDE.md:34-36`) reserves the top-right for the one primary action, and
`docs/ux-patterns.md` has no pagination pattern at all — its queue entries are
§1.2 (one chronological list) and §3.4 (fixed sections). Numbered pages mean
page numbers kept in sync with a 5 s poll; one `Load more` appends and never
renumbers.

**Poll × pages:** refresh **page 1 only**, leaving appended pages as loaded.
Two deliberate consequences: `contentSettled` (`page.tsx:145-146`) must be
evaluated over *all loaded* items or a post publishing on page 3 stops the poll;
and a new item prepends to page 1 without shifting anything below it, which is
why keyset beats `OFFSET` here.

**Cost:** DTO — a cursor on the response (§3 seam); repository — the paging
branch and the batch; web — items-plus-cursor state, a `Load more` button, one
i18n key; `tenancy-lists.e2e.spec.ts:174-177` reads the body as a bare array and
must stay green; new tests for cursor round-trip, tenancy on that branch, and
"one adaptations query per page".

### (b) Bound only: `LIMIT 200` + batched adaptations, no paging UI

Same slim projection and batched fix, plus `ORDER BY created_at DESC, id DESC
LIMIT 200` and a line on the screen saying *showing the latest 200*. Three
statements, roughly 50 KB. Honest **only if the screen says so** — a silently
truncated queue is worse than a slow one.

**Cost:** no DTO change, no cursor, no web state beyond one sentence and its
i18n key; the ratchet untouched. It does not buy the 201st item, and the
headings silently become "…among the latest 200".

### (c) Grouping moved server-side

The server returns the five buckets (or one page per status), so a section
heading means "of this status" again rather than "of what is loaded".

**Cost:** the biggest DTO change of the three (a keyed object, or five cursors);
`page.tsx:477-479` and the `GROUP_STATUSES` order move to the server, where
§3.4's "failures sort first" would then live twice (the runs list already sorts
them first server-side, `runs.repository.ts:250-256`). It solves a problem (a)
creates rather than one that exists today, and makes five queries where one
would do.

## 3. Recommendation

Take **(a)**, in two commits, because its halves carry different risk. The first
is the pure-win half — slim item columns, `ORDER BY created_at DESC, id DESC`,
one `= ANY(...)` adaptations query — with no DTO change, no UI change, 503
statements down to 3 and 774 KB down to ~430 KB on the measured 500-item org,
and every existing test still describing the same response. The second adds
`?limit=&cursor=`, the `Load more` control and the page-1 poll. Prefer **(b)**
only if the owner wants the second half deferred indefinitely: its 200-item
ceiling is fine as a *stated* bound and dishonest as a silent one. Reject
**(c)** for now.

Three seams to get right, none of them in the query:

- **Poll vs. cursor.** Refreshing page 1 while later pages stay frozen means
  `contentSettled` must read all loaded items, or the poll stops early.
- **A status change mid-page.** Status is not the sort key, so nothing jumps
  pages — but the five headings, drawn from one page, stop meaning "every post
  of this status". Say so in the heading, or accept (c) later.
- **The runs strip is a different list.** `Try again` / `Dismiss`
  (`page.tsx:355-391`) render `GET /api/runs?state=open`, already slim
  (`runs.repository.ts:94-97`) and bounded by human dismissal. **Untouched.**
- **The ratchet.** `tenancy-lists.e2e.spec.ts:174-177` reads the list body as a
  bare array, for four other endpoints too. Either the cursor rides in an
  `X-Next-Cursor` header and the body stays an array, or `ListEndpoint` grows an
  `unwrap`. Owner's call (§6).

## 4. Tasks

| # | Task | Files | Tests / mutations |
|---|---|---|---|
| **T1** | Slim list projection: `CONTENT_LIST_COLUMNS` without `body`, beside `ITEM_COLUMNS` | `content.repository.ts:39-54,764` | e2e: list row has no `body`; item response still does. Mutation: put `body` back → a test must fail |
| **T2** | One adaptations query per response: `= ANY(ids)` + group in JS, `ADAPTATION_COLUMNS` reused verbatim | `content.repository.ts:694-703,769-780` | Statement-count test (wrap the pool as this design did): `3` for any N. Mutations: drop the `orgId` predicate; group by the wrong key; return `[]` for an item with no adaptations vs. omitting it |
| **T3** | Deterministic order + index: `ORDER BY created_at DESC, id DESC`, migration adding `(org_id, created_at DESC, id DESC)` | `content.repository.ts:764`, `packages/db/src/schema/content-items.ts:62`, new migration | Test: two items with the *same* `created_at` come back in a stable order across repeated reads. Mutation: drop the `id` tiebreak |
| **T4** | Cursor: `?limit=&cursor=`, encode/decode in `@pubrick/shared`, refuse a malformed cursor with `invalid_request` | `content.controller.ts:37-40`, `content.repository.ts:750`, `packages/shared/src/dto/content.ts` | Round-trip: pages partition the set, no gaps, no repeats across a concurrent insert. Tenancy: another org's cursor yields this org's rows or a refusal, never theirs. Mutations: `<` → `<=`; drop `limit` clamp |
| **T5** | Web: `Load more`, all-loaded-pages settle predicate, page-1 refresh | `page.tsx:145-146,190-199,477-479`, i18n | `page.test.tsx`: poll keeps running while an in-flight item sits on page 2; `Load more` appends and does not refetch page 1; filter change resets to page 1 |
| **T6** | Ratchet decision (header vs. `unwrap`) | `tenancy-lists.e2e.spec.ts:23-37,174-177` | The content entry exercises the cursor branch as a third `path` |

**Pair-shippability:**

| Pair | Together? | Why |
|---|---|---|
| T1 + T2 | **Yes** — one commit | Invisible to every caller; together they are the measured 503 → 3 |
| T2 + T3 | Yes | Order matters only under a `LIMIT`, but landing it early makes T4 a one-line change |
| T3 + T4 | **No — T3 first** | A `LIMIT` over planner order returns an arbitrary subset |
| T4 + T5 | **Yes, and preferably must be** | A cursor no screen sends is untested surface; a `Load more` with no cursor has nothing to call |
| T4 + T6 | **No — T6 first or same commit** | T4 as an envelope breaks the ratchet the moment it lands |
| T5 alone | No | Nothing to page |

## 5. Out of scope

- The other #13 bullets (partial fan-out, stuck-adaptation reconciliation,
  `format`/`disableLinkPreview`, `timestamptz`, staleness bound, `createQueue`,
  the duplicate-send window).
- The runs strip and `GET /api/runs` — a separate list, already slim.
- Reordering the queue (`docs/ux-patterns.md` §1.2) and fixed sections (§3.4).
- Any change to `deliveryOutcome` / `externalUrl` semantics — both templates
  move unchanged — and `GET /api/content/:id`, already single-row.

## 6. Questions only the owner can answer

1. **Page size and control.** 50 or 100 per page, and `Load more` (this
   design's reading of the constitution) or something else?
2. **Cursor on the wire:** `X-Next-Cursor` header keeping the body a bare array,
   or an envelope plus a change to `tenancy-lists.e2e.spec.ts`?
3. **Section headings under a page bound.** Accept "sections of what is loaded"
   (option a), or is a heading that no longer counts every post of its status
   reason enough to do (c) now?
4. **Is (b) wanted as an interim** — "showing the latest 200" — or should the
   queue go straight to (a)?
