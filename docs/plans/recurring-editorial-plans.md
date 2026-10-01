# Weekly editorial plans execution

Status: calendar prerequisite, shared contracts/calculator, transactional
persistence, API/worker integration and Calendar UI landed in the feature branch;
isolated built-browser acceptance in progress.
Updated: 2026-10-01.

Design: [0011](../specs/0011-recurring-editorial-plans.md). Independent discovery
and two adversarial reads resolved pause/resume identity, finite consent,
concurrent capacity, brand deletion, overdue dispatch and snapshot semantics.
Independent dependency review confirmed the sequential ownership below; no
recurring implementation may start until the calendar prerequisite is corrected
and independently verified.

## Landing order and ownership

### 0. Calendar prerequisite

Land the independently reviewed calendar provider-selection and brand-parent
locking fix first. Native regressions must retain the queued provider/model and
credential revision and reproduce the prior brand-delete deadlock. Existing
unconfigured-calendar compatibility remains explicit. Recurring implementation
starts only with this prerequisite applied; it is not an independent worker task.

Integrated and independently verified: see the
[calendar scan review](../reviews/2026-10-01-calendar-scan-isolation.md).

### 1. DTOs and server calculator

One owner: shared plan DTOs/closed reasons and server-only weekly calculator.
Put the calculator in `packages/db/src/editorial-plan-occurrences.ts` and export
it for API and worker use. Add Luxon explicitly to the server-only db package,
preserving shared's zod-only runtime rule. Use existing weekday, channel, brief and consent conventions where they
fit. Preview uses the same calculator as materialization; enforce ISO dates,
finite range, unique/sorted weekdays and channels, strict HH:mm and valid zone.

Tests: DST forward gap, both backward offsets selecting earlier UTC, leap dates,
UTC and non-hour-offset zones, inclusive end, 14 local-day horizon, past/new
identity refusal and retained snapshot behavior. Library handles timezone/day
arithmetic; Pubrick owns the bounded recurrence and consent semantics.

Integrated in the feature branch at `1a4c23f3`, with the PostgreSQL year-zero
boundary correction at `ebe637e0`. Focused verification of the final
contracts passed 20 DTO tests and 22 calculator tests, shared/db typechecks,
scoped lint and the shared package build. Response round trips include opaque
authentication actor IDs and historical fractional-minute IANA offsets.
API, dispatch and UI acceptance remain pending; these unit checks
do not establish a working recurring-plan user journey.

### 2. Schema, migration and transactional repositories

One owner: schema/migration and shared recurring persistence helpers, including
the complete quota/occurrence insertion transactions that the materializer will
invoke. Begin only
after DTO/calculator contracts land. Use tenant/brand-scoped composite links,
immutable slot attribution, unique local-date identity and irreversible dispatch
marker. Disabled save and terminal removal are distinct. Store occurrence-level
consent evidence and snapshots. Reversible suspension must never reset dispatched
or manually skipped identity.

Plan creation, enable/renew and materialization serialize quota-growing writes
on brand NO KEY UPDATE and recheck five active plans/10,000 retained occurrences.
Every batch owns one transaction; no provider network call happens under locks.
Plan/occurrence locks precede slot locks. Revise journal index AND timestamp after
rebasing; get independent migration review before committing migration files.

Tests: native concurrent creates/inserts, same-date replay, cross-tenant/brand
link refusal, enable revision and consent, repeated action semantics, paused and
removed tombstones, deletion of dispatched run/slot, transaction rollback. Prove
new guards with an independent three-run mutation check after integrated review.

Implemented in the feature branch at `e1412d68`. Independent precommit migration
review approved the additive `0126` upgrade, journal ordering, composite scope
links and UPDATE-only immutability guards. The author verified the exact source
commit on PostgreSQL 16.15: 17 native persistence tests, 21 calculator tests and
8 database-tier guard tests passed. The native tier exercised a populated
pre-feature upgrade, concurrent quota admission, pause/edit/resume identity,
transactional rollback, retained dispatch evidence and a measured parent-lock
wait during brand deletion. Disposable test storage was removed.

Slot-to-occurrence attribution uses a one-way scoped FK. Occurrence slot/run
UUIDs are durable audit identifiers, avoiding reciprocal delete triggers that
would invert occurrence/slot lock order. Existing calendar API and worker paths
still require step 3 integration; this persistence milestone alone does not
enable scheduled generation. Subsequent independent persistence guard mutations
are recorded in the [occurrence state proof](../reviews/2026-10-01-editorial-occurrence-state-proof.md).
Full feature acceptance remains pending.

### 3. Session API and worker dispatch integration

One owner initially: recurring API plus changes to existing calendar mutations,
CalendarService and pg-boss queue registration. These share row-order and DTO
contracts; do not dispatch API and worker as independent tasks touching calendar
writers. Sessions require active organization, brand scope and editorial ability;
API/MCP keys grant no access. Mutations require expected revision.

Preview is free of paid calls. Save is disabled; enable requires fresh literal
consent and transactional planner job enqueue. One bounded global scan also
materializes future ordinary slots through step 2's insertion transactions;
it does not duplicate quota checks or occurrence writes. Routine scans preserve existing planned
snapshots. Explicit pause/edit can suspend pending work; enable replans same
identities with new revision. User slot deletion means a permanent skip; internal
pause/remove deletion retains its intended state.

Due dispatch revalidates plan consent, occurrence state/link and permanent marker
under organization/AI selection/brand/plan/occurrence/slot lock order. Atomically
skip beyond one-hour lateness, retain actionable configuration blocks within
the window, and create run/job/dispatched linkage in one transaction. Hosted
admission remains authoritative. Ordinary slot regression tests stay unchanged
apart from required provider-parent parity.

Native tests: pause-vs-dispatch, plan removal/brand deletion, stale revisions,
enable replay, worker redelivery, two materializers, overdue restart/subscription
recovery, missing channel/provider repair, queue failure, tenant and role refusal,
resource admission and exact pinned provider snapshot. Use synthetic DB/media/
credentials and scripted model; no provider or publication calls.

Integrated at `34b65d92` (author source `5b6df186`). Final focused PostgreSQL
16.15 verification passed 16 API/authority tests and 51 worker/queue tests,
including ordinary calendar regressions. Shared, db, API and worker typechecks,
API/worker builds and scoped lint passed. Native tests use measured lock waits
for grant revocation, elapsed dispatch windows and pause/dispatch overlap;
also cover enqueue rollback, configuration repair, pinned selection and planner
redelivery. A quota-deferral omission reproduced a blocked tenant starving the
101st due occurrence; restored source passed. This fairness fixture uses synthetic
quota refusal with real database transactions. A separate regression reproduced
unverified self-hosted session refusal and now checks both permitted self-hosted
access and required hosted verification, matching the canonical identity policy.
The author's test storage was removed. Independent API/worker source review passed.
Selected dispatch guard proofs and their deliberately narrow scope are recorded
in the [native guard review](../reviews/2026-10-01-recurring-dispatch-guards.md).
The integrated full gate/browser journey remain pending.

### 4. Calendar UI and documentation

One owner: separate recurring component on existing brand Calendar, API client,
four locales, component tests and user guide. Begin after session API contract
lands; do not fake undeclared endpoints. Existing month/day page stays the one
location. Show generation time/zone, enabled/disabled/ended state, upcoming dates,
DST skips, blocked reason, finite consent and provider-cost limits.

Save beside form; Enable/Pause/Remove beside plan. Disabled creation needs no
paid consent. Enable and cancellation-bearing edits use explicit confirmation.
Show revision conflict with reload and preserve unsaved form input. Follow shared
status, empty-state, accessible controls, mobile and translation conventions.

Tests: request schema round trips, Russian failure sites with real refusal body,
four-locale parity, keyboard confirmation, disabled-save/enable distinction,
preview zone/offset, stale revision, actionable blocked and ended states.

Calendar UI integrated at `950b154b`, with review fixes at `5cfc95ec` and unavailable
channel repair at `6f36f71d`. Initial focused web verification passed 87 assertions;
affected component checks passed after confirmation and recovery polish. Independent
source review found stale plan summaries after Skip and an error hidden behind the
history dialog. Both have RED regressions and verified fixes; the follow-up source
review passed. That two-file run passed 25 cases and timed out on one unchanged
bulk-selection test, which subsequently passed alone in 8.44 seconds. This is not
reported as a green combined run.

A further source read found that deleted channel IDs could remain invisible in
an edit draft and prevent saving replacement channels. An explicit Remove control
now repairs only unavailable selections, including changes while editing, and
preserves the remaining draft. Its final component/locale tier passed 34 assertions
(13 component and 21 locale checks). Shared tokens, four locales, strict wire
round trips and localized refusal bodies are covered. Earlier web typecheck and
scoped lint passed; final whole-feature types/build and real browser/mobile
acceptance are still required.

## Integrated acceptance

One owner runs the integrated local typecheck/lint/test gate after all slices
land, plus affected native concurrency/mutation and built-browser acceptance.
Real journey creates disabled plan, previews, enables with consent, dispatches
one due scripted generation to a draft, reviews it, pauses/resumes, skips and
removes. Confirm no publication job and no real provider call. Reviewer reads
the combined diff before release; fixes repeat affected checks only.

### Built worker and browser fixture

The browser runner owns a disposable PostgreSQL container, media directory and
bounded receipt file. It passes an explicit environment allowlist with random
test secrets, never the developer's `.env` or saved provider credentials. Build
API, worker and web from the integrated feature source after step 4 lands;
verify the latest migration before beginning the journey. Keep this runner
manual, following the existing isolated browser runners.

Only the compiled worker receives a test-only Node `--import` preload. It
intercepts the existing Google transport's `globalThis.fetch`; it does not add
a production hook or endpoint. Require the disposable marker, loopback database,
synthetic key, exact model endpoint, POST method and structured request body.
Return the SDK's documented candidate/usage envelope with schema-valid scripted
researcher, writer, editor, fact-check and adapter outputs. Match role markers
and a unique journey marker, rather than relying on invocation order. Reject
unrecognized requests without forwarding to the original fetch.

Record an unexpected-call failure durably before throwing. The runner checks
this latch while waiting and at completion, so a caught SDK error cannot make
the journey pass; failure to write the receipt terminates the worker. Store no
request headers or credentials. Require exactly five successful role receipts,
five ledger rows and five checkpoints belonging to the one generated run. Require
each role exactly once, including `adapter:<channelId>`. The fixture selects one
channel, uses `social_post`, disables images and has no knowledge or related
news; otherwise five calls would not describe the actual pipeline. Carry the
journey marker through the scripted draft outputs into fact-check and adaptation.
This intercepts the Google SDK transport, not every possible Node networking
API: the fresh brand has no knowledge, monitoring, webhook or image configuration,
and its manual channel has no publishing credentials.

Use the live clock and choose the first UTC generation minute at least two
minutes ahead and less than three minutes ahead.
Before enabling, require at least sixty seconds remaining; otherwise revise the
still-disabled plan and preview again. Derive the local date and weekday from
that instant, including midnight rollover, and retain a future occurrence for
pause/resume/skip checks. Start the journey deadline after build and readiness;
bound it to eight minutes and generation to the due time plus two minutes,
reserving three minutes for post-generation actions. This is a timeout, not a
promised runtime. Worker exit, failed run or unexpected receipt
fails immediately. Await child shutdown before removing disposable storage.

The UI saves the synthetic Google key and selects the model without running the
provider probe. Create, preview and enable the plan through the actual UI; allow
the real planner, calendar dispatch and compiled generation pipeline to produce
the draft. Open and edit it as a human and verify persisted text, without clicking
Approve. Check the retained provider selection, immutable dispatched occurrence,
manual skip after observing a real planner job complete and terminal removal.
Elapsed time alone does not prove a planner pass. Assert there are no
publication records or pending/completed publish jobs. Keep sanitized failure
logs and record the exact source, runner command and cleanup result.

Record exact source, commands/counts, skipped tiers, migration upgrade and cleanup.
Push a coherent feature milestone once, then open/update one PR. Main release
and public image publication follow their separate current authorization rules.
