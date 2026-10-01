# Weekly editorial plans execution

Status: calendar prerequisite, shared contracts/calculator and transactional
persistence integrated in the feature branch; API/worker integration in progress.
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
enable scheduled generation. Independent combined persistence guard mutations
and full feature acceptance remain pending.

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

## Integrated acceptance

One owner runs the integrated local typecheck/lint/test gate after all slices
land, plus affected native concurrency/mutation and built-browser acceptance.
Real journey creates disabled plan, previews, enables with consent, dispatches
one due scripted generation to a draft, reviews it, pauses/resumes, skips and
removes. Confirm no publication job and no real provider call. Reviewer reads
the combined diff before release; fixes repeat affected checks only.

Record exact source, commands/counts, skipped tiers, migration upgrade and cleanup.
Push a coherent feature milestone once, then open/update one PR. Main release
and public image publication follow their separate current authorization rules.
