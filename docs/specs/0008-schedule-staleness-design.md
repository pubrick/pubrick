# Schedule staleness: how late is too late (Design)

**Date:** 2026-09-11
**Status:** DECIDED, not implemented. **Revision 2**, after the adversarial review
(`.superpowers/sdd/reviews/review-0008-design.md`). Option (a) — a bound checked BY THE WORKER at send time, default
**6 hours**, beyond which the adaptation is `failed` with the coded reason `schedule_missed` and the existing "Publish
now" re-sends. Where this document and the code disagree the code is right; every current-behaviour claim cites
`file:line` at `19263ec`.
**Covers:** issue #17, split out of #13; lands in `docs/specs/README.md` with the code.

## 1. What a 26-hour outage does today

Approve Monday 17:00 for Tuesday 09:00. `approve` refuses a past time
(`apps/api/src/content/content.repository.ts:2673`), writes the adaptation `scheduled` with `scheduled_at`
(`…:2701-2708`), enqueues one job per channel with `startAfter: scheduledAt` (`…:2712-2716` →
`apps/api/src/queue/queue.service.ts:132`) in the same transaction, and sets the item `approved` (`…:2719`). The
worker dies Tuesday 08:00 and returns Wednesday 10:00. **Nothing expires the job in between.** `expireInSeconds: 600`
(`packages/shared/src/jobs.ts:50`) bounds a handler that has STARTED — its own comment says so — and pg-boss's only
other clock on a waiting job is `keep_until = start_after + retention`
(`node_modules/.pnpm/pg-boss@12.28.0/node_modules/pg-boss/dist/plans.js:1578`), default 14 days (`…:47`), after which
the row is **deleted** (`…:2140-2145`), not failed.

Wednesday 10:00 the worker fetches it. **`handle()` never reads `scheduled_at`:** `load()`'s select list omits the
column (`apps/worker/src/publish/publish.repository.ts:357-367`) and `LoadedAdaptation` has no field for it
(`…:16-28`), so none of the pre-send guards — item rejected (`apps/worker/src/publish/publish.service.ts:158`),
already published (`…:171`), adapter (`…:178`), the two claims (`…:199`, `…:226`) — can ask the question. The post
goes out 25 hours late, `published`, indistinguishable from on time; per channel the backlog drains one job at a time
(`groupConcurrency: 1`, `apps/worker/src/queue.service.ts:132-135`) as fast as Telegram allows — the burst, which the
bound below shrinks but does not pace (§5).

**The screen** says "Scheduled for Tue 09:00" (`apps/web/src/app/[locale]/content/[id]/page.tsx:1267-1272`) in blue
for 26 hours, with **no polling** (`scheduled` is deliberately not in-flight,
`apps/web/src/lib/adaptations.ts:85-91`), then green "Published" (`[id]/page.tsx:1224-1241`). Neither state mentions
time. **The record** keeps both halves — `publications.created_at` is the real send for a `published` receipt
(`packages/db/src/schema/content-items.ts:335`; on a refusal it is `claimSend`'s insert time, the moment we declined)
and `scheduled_at` still holds Tuesday 09:00, since `markPublished` does not clear it
(`publish.repository.ts:610-611`) — so the lateness is derivable in SQL, is **nowhere in the product**, and is
erasable: approve overwrites `scheduled_at` (`content.repository.ts:2705`, `null` for "Publish now"), reject nulls it
(`…:2773`).

## 2. The options, priced

**(a) A bound the worker checks at send time. CHOSEN.** Beyond it the delivery is `failed` — nothing reached the
platform — with a coded reason, and the screen offers the re-send it already has. *Where the check goes is the whole
design:* AFTER `claimSend` (`publish.service.ts:226` → `publish.repository.ts:508`), not among the other pre-send
guards. A refused claim means an earlier attempt may have posted and is recorded `unknown`
(`publish.service.ts:227-235`); a staleness check above it would answer "never sent" about a post that may be live —
the verdict this pipeline is built not to guess (`packages/shared/src/dto/content.ts:407-450`). **Not hypothetical:**
a `scheduled` row can hold a live `in_flight` claim — an attempt killed between `claimSend` and its outcome (claim
`in_flight`, row `publishing`); a human rejects, and `reject` writes `pending` while touching no `publications` row
(`content.repository.ts:2771-2782`); they re-approve with a time, and the row is `scheduled` with the claim standing,
invisible to `sweepAbandoned` (scoped to `publishing`, `publish.repository.ts:931-935`) and to `sweepOrphanedClaims`
(scoped to `adaptation_id IS NULL`). Placed after `claimSend`, the branch is shape-identical to the permanent-error
branch (`publish.service.ts:311-318`): nothing has been told to the platform, the claim is ours,
`safeMarkFailed(…, "failed", claim)` stamps the `failed` receipt via `resolveClaim` (`publish.repository.ts:773`), and
the handler RETURNS — never rethrows (`CLAUDE.md:54-60`). The byte-identical alternative —
`throw new PermanentPublishError(…)` inside the `try` — is REJECTED: the code would have to survive an `instanceof`
round-trip.

***Two-sided, not one-sided.*** `lateBySeconds < 0` means a job arrived for a slot that has not come yet, and it is
reachable: an overdue row is still `scheduled`, which `UNSCHEDULABLE_STATUSES = ["queued","publishing"]`
(`content.repository.ts:409-412`) does not refuse, so a human can move the slot FORWARD mid-outage. `approve` then
cancels by payload (`api/queue.service.ts:178`) — but a job already `active` keeps running, and
`CLAIMABLE_STATUSES = OUTSTANDING_ADAPTATION_STATUSES` (`publish.repository.ts:40`; `dto/content.ts:59-64`) includes
`scheduled`, so the old job could claim the re-scheduled row and post it HOURS EARLY. So the branch returns without
sending and without failing when `lateBySeconds < 0`: the job completes, and a job for the new slot provably exists
because `approve` enqueued it in the same transaction as the new time (`…:2712-2716`). No tolerance on the comparison
— both sides are one Postgres clock, and pg-boss delivers only at `start_after <= now()`.

*The clock is Postgres's, not the worker's.* `load()` grows `scheduledAt` and
`lateBySeconds: extract(epoch from now() - scheduled_at)` — null when unscheduled, so "Publish now" can never be
stale. The argument is `publish.repository.ts:43-66`'s for stamping `updated_at` with `now()`: a worker-side
`new Date()` puts two machines on the two sides of the test. It is also the seam (§3).

*The reason is a column, not a sentence.* `last_error` is free `text` (`content-items.ts:129`) printed verbatim
(`[id]/page.tsx:1262-1266`); no closed list exists, and no CHECK for one. The web has already been burned keying
behaviour off a worker sentence's prefix (`adaptations.ts:17-22`: *"a reworded log line turned every unknown delivery
back into a plain red Failed"*). So a nullable `adaptations.failure_reason` typed
`text(…, { enum: PUBLISH_FAILURE_REASONS })` with `enumCheck("adaptations_failure_reason_check", …)` (precedent
`content-items.ts:202`), which `packages/db/src/schema-invariants.test.ts` then polices in both directions for free
(`:79`, `:97`, `:126`). **No new `AdaptationStatus`, no eighth `DeliveryOutcome`:** a missed slot is a `failed`
delivery that provably sent nothing, which is what `failed` already means and what makes re-approve safe
(`content.repository.ts:2676`).

***The list is closed over today's failures; `null` is not an "other" bucket.*** Every terminal write of
`adaptations.status` that exists today gets a code, so the column always answers for the row's CURRENT verdict:

| Reason code | Written by |
|---|---|
| `schedule_missed` | the bound (T1); T3's no-job sweep, unclaimed arm |
| `no_adapter` | `publish.service.ts:186` — no publisher for the platform |
| `credentials_unreadable` | `…:275` (`UNREADABLE_CREDENTIALS_MESSAGE`) |
| `credentials_missing` | `…:279` — `Could not load credentials: …`, the channel row is gone |
| `credentials_invalid` | `…:293` — stored credentials fail the adapter's schema |
| `platform_rejected` | `PermanentPublishError` out of `publisher.publish()` (`…:311-318`) |
| `retries_exhausted` | `markExhausted` → `…:380`, the DLQ handler |
| `send_abandoned` | `sweepAbandoned`'s no-claim arm (`publish.repository.ts:938-942`) |
| `outcome_unknown` | `recordUnknownOutcome` (`…:228`, `…:308`, `…:480`); `sweepAbandoned`'s and T3's claimed arms |

`last_error` keeps its free text everywhere: the code says which CLASS, the sentence says the platform's own words —
and `platform_rejected` is the class where free text must remain, because Telegram writes it. `publications.error`
gets only the sentence; a per-attempt code is deferred (§5). `null` survives for one population: rows that failed
BEFORE the migration, rendered from `last_error` as today.

***Every writer writes it or clears it.*** A nullable column written by one branch and cleared by none is the stale
flag this section cites `adaptations.ts:17-22` to avoid, one column over: a later credentials failure would leave
`schedule_missed` beside a decryption sentence, and T2 would caption it "Missed its slot". In the design, not left to
implementation: `markFailed` (`publish.repository.ts:733`) takes a **required** `failureReason: PublishFailureReason`
— required, so the five existing call sites cannot forget it and the mutation "drop the argument" does not typecheck —
and `safeMarkFailed` (`publish.service.ts:603-612`) forwards it. `markPublished` (`:610`), `markAlreadyPublished`
(`:690`), `markPublishing` (`:469-471`), `sweepAbandoned`'s raw `.set()` (`:938`), `approve`
(`content.repository.ts:2701-2708`) and `reject` (`…:2771-2780`) each add `failureReason: null` beside the `lastError`
they already clear — `reject`'s own comment ("leaving the last platform error behind makes a rejected adaptation look
like a failed one") is the argument verbatim. The ratchet greps every `.set({ status:` on `adaptations` across `apps/`
and `packages/` and asserts each writer names `failureReason` or is listed exempt with a reason; the behavioural test
is an e2e — fail a row `schedule_missed`, re-approve, fail it permanently, assert the column reads
`credentials_invalid`.

**(b) A `needs_confirmation` adaptation status. REJECTED, but bought anyway.** A new member of `ADAPTATION_STATUSES`
(`dto/content.ts:24-31`) costs the CHECK (`content-items.ts:202`), a decision in `OUTSTANDING_ADAPTATION_STATUSES`
(`…:59-64` — also the claimable and cancel sets), an automatic new `DeliveryOutcome` (`…:451`) with two web `Record`s
(`adaptations.ts:52`, `:67`), approve's target list and a resolver route — the budget #16 spends once already (`0007`
§2). It also invents a row that LOOKS outstanding while no job will move it, waiting on a human who is asleep. Option
(a) asks the same question with no new state.

**(c) Publish late and caption the receipt. REJECTED as the default** — today's behaviour with a label, against the
issue's standard; a caption after the send is not a decision. Half of it is kept: the missed slot is stated with the
hours.

**The mixed fan-out, and #16.** One channel delivered, one missed: `published` and `failed`, both terminal. **Today**
`recomputeItemStatus` (`publish.repository.ts:1088-1118`) yields a verdict only when every adaptation agrees, so until
#16 lands such an item stays `approved` for ever with one `schedule_missed` row — recoverable (`approve` targets
`["pending","failed","scheduled"]`, `:2676`) but not visible. After #16 it is `partially_published` with no extra code
(`0007` §2–§3), whose "Send to the N channels that failed" (§4.4) counts `failed` and excludes `unknown`. No shared
code; either order lands.

**The default: 6 hours, as an env var.** Below, it must never be reachable by the system's own delays or it fails
posts that were merely retried. Derived, at today's `PUBLISH_QUEUE_OPTIONS` (`jobs.ts:44-53`): pg-boss's backoff is
uniform in `[retryDelay·2^rc, retryDelay·2^(rc+1)]`, capped at `retryDelayMax` (`plans.js:1762-1768`), so at
`retryDelay: 30` the five delays are 30–60, 60–120, 120–240, 240–480 and 480–960 s — **Σ max 1 860 s ≈ 31 min**, and
`retryDelayMax: 3600` never binds at `retryLimit: 5`, though it is the parameter that would make this arithmetic bite
if the limit rose. Then the attempts: realistically `TELEGRAM_REQUEST_TIMEOUT_MS = 30_000`
(`packages/integrations/src/telegram.ts:23`, enforced `:276`) plus `PUBLISH_RECORD_BUDGET_MS`
(`publish.service.ts:63`), 6 × ~1 min ≈ **40 min**; on paper `expireInSeconds: 600` per attempt plus pg-boss's 60 s
supervise granularity (`attorney.js:540`), 31 min + 6 × 600 s + 6 × 60 s ≈ **1 h 37 min**. Add the sweep's
`PUBLISH_ABANDONED_AFTER_SECONDS = 1 200 s` (`publish.repository.ts:292-294`): **≈ 1 h realistic, ≈ 1 h 57 min on
paper**, so 6 h is **3.08×** the paper worst case. (Head-of-line blocking by `groupConcurrency: 1` is not a path — a
job in `retry` is not `active`; a rolling deploy is reclaimed in ~1–2 min by `heartbeatSeconds: 30`.)

***That margin is a test, not a paragraph.*** The repo already does this for
`PUBLISH_ABANDONED_GRACE_SECONDS = PUBLISH_QUEUE_OPTIONS.expireInSeconds` (`publish.repository.ts:290`, whose
docstring says the relationship is asserted in a spec so that shortening the expiry fails a test). So
`worstCaseSelfInflictedSeconds(opts)` lives in `packages/shared` beside `PUBLISH_QUEUE_OPTIONS` — the backoff sum plus
`(retryLimit + 1) × (expireInSeconds + superviseIntervalSeconds)` — and a test asserts
`worstCaseSelfInflictedSeconds(PUBLISH_QUEUE_OPTIONS) + PUBLISH_ABANDONED_AFTER_SECONDS < PUBLISH_MAX_LATENESS_HOURS_DEFAULT * 3600`.
Raising `retryLimit` to 8 pushes the chain past 3 h and to 10 past 6 h; with the assertion that is a red test in the
queue-tuning PR instead of customers' posts failing silently.

Above, the defining failure is "yesterday's post today", so the bound is under 24 h by construction: Tuesday 09:00
landing Tuesday 15:00 still meets roughly the day and audience it was written for, where Wednesday morning does not. 6
h is the round number in that gap. `PUBLISH_MAX_LATENESS_HOURS`,
`z.coerce.number().finite().min(0.25).max(8760).default(6)` in `apps/worker/src/env.ts` — which today declares no
publish variable at all and fails at boot through `parseEnv`, not at the first publish — **with no off switch**: a
fail-open `0` would restore this spec's own silence, `Infinity` would reach `make_interval` as a runtime surprise
"fails at boot" does not cover, and unbounded is spelled `8760`. **Not per-org, yet:** no settings table or column
exists (`packages/db/src/schema/*.ts`), so per-org means a table, a repository, a route, a screen and an org-scoped
read on the worker's hot path. The env var is forward-compatible, and it is a WORKER variable — T2's overdue painting
lives in the web, which needs no access to it (`scheduled_at < now()` is the whole predicate there).

## 3. Recommendation, the pinning test, and the seams

Take (a), two-sided: the worker asks how late the slot is immediately after `claimSend` succeeds, refuses beyond
`PUBLISH_MAX_LATENESS_HOURS` (default 6) as a plain `failed` with a coded `failure_reason`, and returns untouched when
the slot is in the future. Nothing here retries or rethrows: the handler returns and pg-boss completes the job.

**The test that pins the 26-hour outage.** `now()` is NOT injectable in the worker — `PublishService`'s `@Optional()`
seams are the publisher lookup, the base URL and a retry delay (`publish.service.ts:139-146`) — and must not become
so: the comparison belongs to the database (§2). So the clock is backdated, not mocked, at both tiers:

- `publish.repository.spec.ts` (real Postgres, `describe.skipIf(!url)`, `:28`): seed a `scheduled` adaptation at
  `now() - interval '26 hours'`, `load()`, assert `lateBySeconds` falls in a WINDOW around 93 600 — seed and read are
  separate statements, and a rounded equality flakes on a slow box; at one hour it is not late; a slot an hour ahead
  is negative; `scheduled_at IS NULL` is `null`.
- `publish.service.spec.ts` (mocked repo, `:45-77`): `fixture({ lateBySeconds: 26 * 3600 })` — one field, `load` is a
  `vi.fn()` — asserts the publisher was **never called**, `markFailed` took `"schedule_missed"` AND the claim,
  `releaseSend` was not called, `handle()` did not throw; mirrors at `6 * 3600 - 1` (publishes) and `-3600` (returns,
  nothing called). This tier tests the COMPARISON and never the computation: the fixture supplies the number.
- `publish.e2e.spec.ts`: a backdated scheduled row through the real handler leaves `failed` + `schedule_missed` + a
  `failed` receipt and no call to the Telegram stub — the only place both halves run together. The row is inserted
  DIRECTLY, because `approve` refuses a past time (`content.repository.ts:2673`); that is the shape a real outage
  produces, and it means no test exercises approve → `startAfter` → a job becoming due. Accepted, and stated. Plus
  §2's re-approve test of the writer contract.

**Seams a whole-branch review must attack.**
1. *The `unknown` inversion.* Hoist the check one line above `claimSend` and a possibly-live post is labelled "missed
   its slot, never sent" — the invitation to re-approve into a duplicate. The pinning test seeds the REAL row that
   produces it: claim `in_flight`, `reject`, re-approve (§2).
2. *A job retried across the bound.* A transient failure at T+5h55m leaves the row `publishing` (`recordTransient`
   does not move the status, `publish.repository.ts:804-813`) and pg-boss redelivers past the bound. The redelivery
   DOES fail it — the bound is about the reader, not about how hard we tried — so check the transient `last_error` is
   replaced by the missed-slot reason rather than the two disagreeing on one row.
3. *A schedule edited while late.* A re-approve during the outage cancels by payload and bumps `attempt_count`
   (`content.repository.ts:2695-2716`), allowed because `requireScheduleReachesEveryChannel` refuses only
   `queued`/`publishing` (`…:409-412`, `…:2188-2213`). What closes it is the negative arm, not a test of behaviour the
   code lacks: verify the woken worker's `active` job returns without sending under the new future time.
4. *The row nobody will ever fail.* After 14 days pg-boss DELETES a waiting job (`plans.js:2140-2145`) and
   `sweepAbandoned` only looks at `publishing` (`:931-935`), so the adaptation sits `scheduled` — or `queued`, which
   `approve` does not even target — for ever with no job (T3).
5. *#16.* A missed half plus a delivered half must reach `partially_published` whichever lands first.

## 4. Tasks

| Task | Ships alone? | What its pair owes it |
|---|---|---|
| T1 — the bound, the reason contract, the derived floor | **yes** (the failure is recorded, and the screen already prints `last_error`) | nothing |
| T2 — the coded reason on the screen | **no** — needs T1's column | T1's migration and `PUBLISH_FAILURE_REASONS`, plus `@pubrick/shared`'s `dist` rebuilt (`CLAUDE.md:323-327`) |
| T3 — the no-job sweep for `scheduled` and `queued` | **yes**, after T1 | T1's reason values and `markFailed`'s required parameter |
| T4 — docs, lock order and CHANGELOG | last by construction | T3's new lock edge |

**T1 — the bound (migration + shared + worker + the two api clears).** *Files:* a migration in
`packages/db/migrations/` — **tag `0019`**: `_journal.json` ends at `0016` and `0007`'s T1, which lands first, claims
`0017` and `0018`, so **derive the tag with `drizzle-kit generate` AFTER rebasing on `0007`, never by copying it out
of this document** (two branches each emitting `0017_*.sql` collide in `_journal.json`, and the tag inside the SQL and
the journal entry must move together) — plus `packages/db/src/schema/content-items.ts`,
`packages/shared/src/{dto/content.ts,jobs.ts}`, `apps/worker/src/env.ts`, `publish.{repository,service}.ts` (`load`'s
two new fields; `markFailed`'s required reason and `safeMarkFailed`'s forwarding; `markPublished`,
`markAlreadyPublished`, `markPublishing`, `sweepAbandoned`'s `.set()`) and `content.repository.ts` (`approve`,
`reject`). *Steps:* migration (one nullable column, no row rewritten — nothing for `expectNoRowRewritten` to catch) →
`PUBLISH_FAILURE_REASONS` and its CHECK → the required parameter through every writer →
`worstCaseSelfInflictedSeconds` and its assertion → `PUBLISH_MAX_LATENESS_HOURS` → `load` returns `scheduledAt` and
`lateBySeconds` computed by Postgres → the two-sided branch after `claimSend`, shaped like `:311-318`, its
`last_error` naming the slot and the hours AT REFUSAL — frozen, because `scheduled_at` is never cleared on failure and
a number recomputed later would grow for ever and disagree with the stored sentence. *Tests:* §3's four. *Mutations:*
hoist the check above `claimSend`; drop the negative arm; `>` → `>=`; drop the null-schedule exemption; drop
`failureReason: null` from `approve`/`reject`/`markPublished`; compute the lateness from `new Date()` (killed by a
session-zone test shaped like `packages/db/src/timestamp-zone.test.ts`); rethrow instead of return. *Agent:* a
worker+db agent in its own checkout, PostgreSQL suites serialised against other agents on the same test database.

**T2 — what the person reads (api + web).** *Files:* `content.repository.ts` (`ADAPTATION_COLUMNS` grows
`failureReason` beside `lastError`, `:438`), `…/content/[id]/page.tsx`, `…/content/page.tsx`,
`apps/web/messages/{en,es,ru,pt}.json`. *Steps:* expose the column → on a `failed` row whose reason is
`schedule_missed` render the translated "Missed its slot by {hours} h — publish now?" instead of the raw `last_error`
(`[id]/page.tsx:1262-1266`), the hours taken from the frozen sentence T1 wrote rather than recomputed → say the same
on the LIST screen (`content/page.tsx`), not only the detail one → paint an overdue `scheduled` row as overdue purely
from `scheduled_at < now()` (`[id]/page.tsx:1267-1272`), the only thing that makes an outage visible while it happens
→ four locales. *Tests:* one per branch; `messages-parity.test.ts`. *Mutations:* key the sentence off `last_error`'s
text rather than the column (the defect `adaptations.ts:17-22` exists to have ended); recompute the hours at render;
drop the overdue rendering; drop the list screen. *Agent:* a web agent, after T1.

**T3 — the sweep for a job that no longer exists.** *Files:* `publish.repository.ts` (a third arm beside
`sweepAbandoned`'s two, `:911`, driven from `publish.service.ts:411-414`). *Steps:* `scheduled` rows whose
`scheduled_at` is older than the bound, AND `queued` rows whose `updated_at` is — they carry no `scheduled_at`, and
`approve` does not target `queued` (`:2676`), so a stranded one is unreachable by every human path, the trap
`publishing` used to be — with no live pg-boss job (`noLiveJob`, `:925-931`, reused) → **the two-verdict fork, copied
from `sweepAbandoned`'s `claimed` sub-select (`:915-920`): a live `in_flight` claim means a post may be out there, so
the row gets `outcome_unknown` and the "check the channel before re-approving" sentence; only a row with no claim gets
`failed`/`schedule_missed`.** A flat `failed` would assert "never sent" about the exact row §2 shows can hold a live
claim, and `failed` is re-approvable. The statement takes the same ascending-id
`WHERE id IN (SELECT … ORDER BY id FOR UPDATE)` sub-select as its siblings (`:880-900` records the measured `40P01`
against `POST /api/content/:id/reject`) — and note the NEW counterparty: this candidate set is walked by `approve`
(`lockAdaptations(…, ["pending","failed","scheduled"])`, `:2676`) as well as by `reject`, which `sweepAbandoned` never
contended with. Log with `logger.error`, org and channel named, as `publish.service.ts:418` does. *Tests:* real-DB
spec — swept when the job is gone, untouched while it exists, untouched inside the bound, `queued` swept the same way,
and the reject→re-approve row seeded so the claimed arm runs. Plan it once on a seeded database: the candidate set is
"everything that backed up during the outage" and `pgboss.job` is partitioned and unindexed on
`data->>'adaptationId'`; if it plans as a nested loop, make it one anti-join over a materialised id set. *Mutations:*
drop `noLiveJob`; drop the bound; drop the claimed arm; drop the ordered sub-select. *Agent:* the worker agent.

**T4 — docs, lock order and CHANGELOG.** *Files:* `docs/specs/README.md`, `docs/lock-order.md` — **T3 adds a real
edge**, its bulk sweep contending with `approve` over `scheduled`/`queued`, so revision 1's "no lock-order change" was
wrong — `docs/self-hosting.md` (the env var, and what setting it low does), `CHANGELOG.md` (`Added`: the bound and the
reason; `Fixed`: a post no longer publishes silently a day late).

## 5. Out of scope

The other #13 follow-ups (queue pagination/N+1, `format`/`disableLinkPreview`, `createQueue`'s update helper, the
residual duplicate-send window); #16's `partially_published` and its `unknown` resolver; a per-org or per-brand bound
(§2); a per-attempt reason code on `publications` (§2); notifications of any kind (this product has no notification
path); how a schedule is CHOSEN (recurrence, quiet hours, timezones); rate-limited draining of a backlog, a different
fix for the other half of the burst (§1).
