# Schedule staleness: how late is too late (Design)

**Date:** 2026-09-11
**Status:** DECIDED, not implemented. Option (a) — a bound checked BY THE WORKER at
send time, default **6 hours**, beyond which the adaptation is `failed` with the
coded reason `schedule_missed` and the existing "Publish now" re-sends. Where this
document and the code disagree the code is right; every current-behaviour claim
cites `file:line` at `19263ec`.
**Covers:** issue #17, split out of #13. Lands in `docs/specs/README.md` with the
implementation.

## 1. What a 26-hour outage does today

Approve Monday 17:00 for Tuesday 09:00. `approve` refuses a past time
(`apps/api/src/content/content.repository.ts:2673`), writes the adaptation
`scheduled` with `scheduled_at` (`…:2704-2706`), enqueues one job per channel with
`startAfter: scheduledAt` (`apps/api/src/queue/queue.service.ts:132`) in the same
transaction, and sets the item `approved` (`…:2719`).

The worker dies Tuesday 08:00 and returns Wednesday 10:00. **Nothing expires the job
in between.** `expireInSeconds: 600` (`packages/shared/src/jobs.ts:50`) bounds a
handler that has STARTED — its own comment says so — and pg-boss's only other clock
on a waiting job is `keep_until = start_after + retention`
(`node_modules/.pnpm/pg-boss@12.28.0/node_modules/pg-boss/dist/plans.js:1578`),
default 14 days (`…/plans.js:48`), after which the row is **deleted**
(`…/plans.js:2144`) rather than failed.

Wednesday 10:00 the worker fetches it. **`handle()` never reads `scheduled_at`:**
`load()`'s select list omits the column
(`apps/worker/src/publish/publish.repository.ts:357-367`) and `LoadedAdaptation` has
no field for it (`…:16-28`), so no check before a send — item rejected
(`apps/worker/src/publish/publish.service.ts:158`), already published (`…:171`),
adapter (`…:178`), the two claims (`…:199`, `…:226`) — can ask the question. The post
goes out 25 hours late, `published`, indistinguishable from on time; per channel the
backlog drains one job at a time (`groupConcurrency: 1`,
`apps/worker/src/queue.service.ts:132-135`) as fast as Telegram allows — the burst.

**The screen** says "Scheduled for Tue 09:00"
(`apps/web/src/app/[locale]/content/[id]/page.tsx:1267-1272`) in `scheduled`'s blue
for 26 hours, with **no polling** (`scheduled` is deliberately not an in-flight
status, `apps/web/src/lib/adaptations.ts:85-91`), then green "Published" with a link
(`[id]/page.tsx:1224-1241`). Neither state mentions time. **The record** keeps both
halves — `publications.created_at` is the real send
(`packages/db/src/schema/content-items.ts:335`) and `adaptations.scheduled_at` still
holds Tuesday 09:00, since `markPublished` does not clear it
(`publish.repository.ts:608-611`) — so the lateness is derivable in SQL, is **nowhere
in the product**, and is erasable: the next approve overwrites `scheduled_at`
(`content.repository.ts:2704-2706`; `null` for "Publish now"), a reject nulls it
(`…:2774`).

## 2. The options, priced

**(a) A bound the worker checks at send time. CHOSEN.** Beyond it the delivery is
`failed` — nothing reached the platform — with a coded reason, and the item screen
offers the re-send it already has. *Where the check goes is the whole design:* AFTER `claimSend`
(`publish.service.ts:226`), not among the other pre-send guards. A refused claim
means an earlier attempt may have posted and is recorded `unknown` (`…:227-235`); a
staleness check above it would answer "never sent" about a post that may be live —
the one verdict this pipeline is built not to guess
(`packages/shared/src/dto/content.ts:407-450`). Placed after it, the branch is
shape-identical to the permanent-error branch (`publish.service.ts:311-318`):
nothing has been told to the platform, the claim is ours, `safeMarkFailed(…,
"failed", claim)` stamps it as the `failed` receipt via `resolveClaim`
(`publish.repository.ts:773`), and the handler RETURNS — never rethrows
(`CLAUDE.md:54-60`).

*The clock is Postgres's, not the worker's.* `load()` grows `scheduledAt` and
`lateBySeconds: extract(epoch from now() - scheduled_at)` — null when unscheduled, so
"Publish now" can never be stale. The argument is `publish.repository.ts:44-60`'s for
stamping `updated_at` with `now()`, and the clock is `sweepAbandoned`'s (`…:933`): a
worker-side `new Date()` puts two machines on the two sides of a staleness test, and
it is also the test seam (§3).

*The reason is a column, not a sentence.* `last_error` is free `text`
(`packages/db/src/schema/content-items.ts:129`) printed verbatim
(`[id]/page.tsx:1262-1266`); no closed list of failure reasons exists, and no CHECK
for one. The web has already been burned keying behaviour off a worker sentence's
prefix (`apps/web/src/lib/adaptations.ts:17-22`: *"a reworded log line turned every
unknown delivery back into a plain red Failed"*). So `PUBLISH_FAILURE_REASONS =
["schedule_missed"]` in `packages/shared`, and a nullable `adaptations.failure_reason`
with `enumCheck` (precedent `schema/content-items.ts:202`), null for every other
failure and every existing row. **No new `AdaptationStatus`, no eighth
`DeliveryOutcome`:** a missed slot is a `failed` delivery that provably sent nothing,
which is what `failed` already means and what makes re-approve safe
(`content.repository.ts:2677`).

**(b) A `needs_confirmation` adaptation status. REJECTED, but bought anyway.** A new
member of `ADAPTATION_STATUSES` (`packages/shared/src/dto/content.ts:24-31`) costs
the CHECK (`schema/content-items.ts:202`), a decision in
`OUTSTANDING_ADAPTATION_STATUSES` (`…/content.ts:59-64` — also the worker's claimable
set, `publish.repository.ts:40`, and the cancel set), an automatic new
`DeliveryOutcome` (`…/content.ts:451`) with two web `Record`s (`adaptations.ts:52`,
`:67`), approve's target list and a resolver route — the budget #16 spends once
already (`docs/specs/0007-partial-delivery-design.md` §2). It also invents a row that
LOOKS outstanding while no job will move it, waiting on a human who is asleep: the
burst becomes a pile of questions. Option (a) asks the same question with no new
state — `failed` + `schedule_missed` + a button that re-sends IS "publish it
anyway?".

**(c) Publish late and caption the receipt. REJECTED as the default** — today's
behaviour with a label, against the issue's standard; a caption written after the
send is not a decision. Half of it is kept: the missed slot is stated with the hours,
so "how late" reaches the screen and the receipt.

**The mixed fan-out, and #16.** One channel delivered before the outage, one missed:
`published` and `failed`, every row terminal — #16's third verdict
`partially_published` with no extra code (`0007` §2–§3), and its "Send to the N
channels that failed" label (§4.4) counts the missed one correctly, counting `failed`
and excluding `unknown`. The designs share no code — this one adds no status and no
item-level verdict, #16's backfill reads statuses only — so either order lands.

**The default: 6 hours, as an env var.** Below, it must never be reachable by the
system's own delays or it fails posts that were merely retried — `retryLimit: 5`,
30s doubling capped at 3600 (`jobs.ts:45-48`), attempts bounded by
`expireInSeconds: 600` (`…:50`), worst case ≈ 1.1 h, plus the abandoned sweep's
1200 s window (`publish.repository.ts:290-294`). Above, the defining failure is
"yesterday's post today", so it is under 24 h by construction: a post written for
Tuesday 09:00 landing Tuesday 15:00 still meets roughly the day and audience it was
written for, where Wednesday morning does not. 6 h is the round number in that
gap: only a real outage reaches it. `PUBLISH_MAX_LATENESS_HOURS`,
`z.coerce.number().positive().default(6)` in `apps/worker/src/env.ts` (which fails
at boot, not at the first publish), **with no off switch** — a fail-open `0` would
restore this spec's own silence; unbounded is spelled `8760`.

**Not a per-org setting, yet.** No settings table and no settings column exist
(`packages/db/src/schema/*.ts`): per-org means a table, a repository, a route, a
screen, and an org-scoped read on the worker's hot path. The env var is
forward-compatible — a per-org value, when one exists, falls back to it.

## 3. Recommendation, the pinning test, and the seams

Take (a): about to send, the worker asks how late the slot is and refuses beyond
`PUBLISH_MAX_LATENESS_HOURS` (default 6). The check sits immediately after
`claimSend` succeeds, so an attempt whose predecessor may already have posted still
reports `unknown` and is never relabelled "never sent". The verdict is a plain
`failed` with a new coded `failure_reason`, because this product has already paid
for keying the web off a worker's English sentence, and because `failed` is what
"nothing reached the platform" means everywhere else. The item screen says how late
it was and offers the re-send it already has, so "ask" is answered without a new
lifecycle state, and a mixed fan-out lands on #16's `partially_published` with no
shared code. The bound is an env var because this repo has nowhere to put a per-org
setting yet, and 6 hours sits above every delay the queue can inflict on itself
(~1.1 h of retries plus a 20-minute sweep window) and below the 24 h that makes it
yesterday's post. Nothing here retries, rethrows or re-sends: the handler returns
and pg-boss completes the job.

**The test that pins the 26-hour outage.** `now()` is NOT injectable in the worker —
`PublishService`'s `@Optional()` seams are the publisher lookup, the base URL and a
retry delay (`publish.service.ts:139-146`) — and must not become so: the comparison
belongs to the database (§2). So the clock is backdated, not mocked, at both tiers:

- `publish.repository.spec.ts` (real Postgres, `describe.skipIf(!url)`, `:28`): seed
  a `scheduled` adaptation at `now() - interval '26 hours'`, `load()`, assert
  `lateBySeconds ≈ 93600`; at one hour it is not late; `scheduled_at IS NULL` is
  `null`.
- `publish.service.spec.ts` (mocked repo, `:45-77`): `fixture({ lateBySeconds: 26 *
  3600 })` — one field, `load` is a `vi.fn()` — asserts the publisher was **never
  called**, `markFailed` took `"schedule_missed"` AND the claim, `releaseSend` was
  not called, `handle()` did not throw; mirror at `6 * 3600 - 1` still publishes.
- `publish.e2e.spec.ts`: a backdated scheduled row through the real handler leaves
  `failed` + reason + a `failed` receipt and no call to the Telegram stub.

**Seams a whole-branch review must attack.**
1. *The `unknown` inversion.* Hoist the check one line above `claimSend` and a
   possibly-live post is labelled "missed its slot, never sent" — the invitation to
   re-approve into a duplicate. A test must fail on that hoist.
2. *A job retried across the bound.* A transient failure at T+5h55m leaves the row
   `publishing` (`recordTransient` does not move the status,
   `publish.repository.ts:804`) and pg-boss redelivers past the bound. The redelivery
   DOES fail it — the bound is about the reader, not about how hard we tried — so
   check the transient `last_error` is replaced by the missed-slot reason rather than
   the two disagreeing on one row, and the attempt/claim bookkeeping is the permanent
   branch's.
3. *A schedule edited while late.* A re-approve during the outage cancels by payload
   and bumps `attempt_count` (`content.repository.ts:2698-2717`,
   `apps/api/src/queue/queue.service.ts:178`), and is allowed because
   `requireScheduleReachesEveryChannel` refuses only `queued`/`publishing`
   (`…:2188-2213`) while an overdue row is still `scheduled` — verify the woken
   worker's old job cannot deliver under the new time, and that "Publish now"
   (which nulls `scheduled_at`) is exempt by construction.
4. *The row nobody will ever fail.* After 14 days pg-boss DELETES a waiting job
   (`plans.js:2144`) and `sweepAbandoned` only looks at `publishing`
   (`publish.repository.ts:931-934`), so the adaptation sits `scheduled` for ever
   with no job — the state the bound exists to end (T3).
5. *#16.* A missed half plus a delivered half must reach `partially_published`
   whichever design lands first.

## 4. Tasks

| Task | Ships alone? | What its pair owes it |
|---|---|---|
| T1 — the bound, in the worker | **yes** (the failure is recorded, and the screen already prints `last_error`) | nothing |
| T2 — the coded reason on the screen | **no** — needs T1's column | T1's migration and `PUBLISH_FAILURE_REASONS`, plus `@pubrick/shared`'s `dist` rebuilt (`CLAUDE.md:323-327`) |
| T3 — the `scheduled`-with-no-job sweep | **yes**, after T1 | T1's reason value |
| T4 — docs and CHANGELOG | last by construction | nothing |

**T1 — the bound (migration + shared + worker).** *Files:*
`packages/db/migrations/0017_*.sql` (next free tag — `0010` is absent from
`meta/_journal.json` and stays absent), `packages/db/src/schema/content-items.ts`,
`packages/shared/src/dto/content.ts`, `apps/worker/src/env.ts`, and
`publish.{repository,service}.ts` (`load`'s two new fields; `markFailed` carries the
reason).
*Steps:* migration (one nullable column, no row rewritten — nothing for
`expectNoRowRewritten` to catch) → the closed list and its CHECK →
`PUBLISH_MAX_LATENESS_HOURS` → `load` returns `scheduledAt` and `lateBySeconds`
computed by Postgres → the branch after `claimSend`, shaped like `:311-318`, its
`last_error` naming the slot and the hours. *Tests:* §3's three. *Mutations:* hoist
the check above `claimSend`; `>` → `>=`; drop the null-schedule exemption; compute
the lateness from `new Date()` (killed by a session-zone test shaped like
`packages/db/src/timestamp-zone.test.ts`); rethrow instead of return. *Agent:* a
worker+db agent in its own checkout, PostgreSQL suites serialised against other
agents on the same test database.

**T2 — what the person reads (api + web).** *Files:*
`apps/api/src/content/content.repository.ts` (`ADAPTATION_COLUMNS` grows
`failureReason` beside `lastError`, `:438`), `…/content/[id]/page.tsx`,
`…/content/page.tsx`, `apps/web/messages/{en,es,ru,pt}.json`. *Steps:* expose the
column → on a `failed` row whose reason is `schedule_missed` render the translated
"Missed its slot by {hours} h — publish now?" instead of the raw `last_error`
(`[id]/page.tsx:1262-1266`), hours from `scheduledAt`, already in the DTO
(`content.repository.ts:436`) → paint an overdue `scheduled` row as overdue
(`[id]/page.tsx:1267-1272`), the only thing that makes an outage visible while it
happens → four locales. *Tests:* one per branch; `messages-parity.test.ts`.
*Mutations:* key the sentence off `last_error`'s text rather than the column (the
defect `adaptations.ts:17-22` exists to have ended); drop the overdue rendering.
*Agent:* a web agent, after T1.

**T3 — the sweep for a job that no longer exists.** *Files:*
`apps/worker/src/publish/publish.repository.ts` (a third arm beside
`sweepAbandoned`'s two, `:911`, driven from `publish.service.ts:411-414`). *Steps:*
`scheduled` rows older than the bound with no live pg-boss job (`noLiveJob`,
`:925-931`, reused) become `failed` + `schedule_missed`, logged as loudly as their
siblings. *Tests:* real-DB spec — swept when the job is gone, untouched while it
exists, untouched inside the bound. *Mutations:* drop `noLiveJob` (fails every live
scheduled post); drop the bound (fails every future post). *Agent:* the worker agent.

**T4 — docs and CHANGELOG.** *Files:* `docs/specs/README.md`, `docs/self-hosting.md`
(the env var, and what setting it low does), `CHANGELOG.md` (`Added`: the bound and
the reason; `Fixed`: a post no longer publishes silently a day late). No lock-order
change: T1 and T3 take `markFailed`'s own locks, in that order.

## 5. Out of scope

The other #13 follow-ups (queue pagination/N+1, `format`/`disableLinkPreview`,
`createQueue`'s update helper, the residual duplicate-send window); #16's
`partially_published` and its `unknown` resolver; a per-org or per-brand bound (§2);
notifications of any kind — a missed slot is seen only by someone who opens the queue,
and this product has no notification path; how a schedule is CHOSEN (recurrence,
quiet hours, timezones); rate-limited draining of a backlog, a different fix for the
other half of the burst.
