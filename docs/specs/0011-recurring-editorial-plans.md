# Weekly editorial plans

Status: reviewed; contracts/calculator and persistence implemented in the feature
branch; API, dispatch and UI pending. Updated: 2026-10-01.

## User outcome

An editor can prepare a repeating weekly draft brief from a brand's Calendar:
choose weekdays, local generation time, timezone and destination channels;
preview upcoming dates; save disabled; explicitly enable paid BYOK generation;
pause it when needed. Generated drafts enter the existing review workflow.
The selected time is when generation may start, not a publication promise.

This first slice supports social-post briefs without automatic images. Evergreen
source snapshots, arbitrary RRULEs, optimal publication times and Telegram
decisions remain later roadmap work. Existing Autopilot remains an independent
source of draft generation; its daily spend setting does not cover these plans.

## Boundaries and consent

- Organization and brand access reuse session authorization and editorial
  capability. Members who cannot edit cannot create, change or enable a plan.
  API/MCP scoped write keys do not gain recurring access.
- Save creates a disabled plan. Enabling requires literal paid-generation consent
  using the existing BYOK consent version. The UI states that every occurrence
  can incur multiple provider calls and that unknown costs remain unknown.
- At most five nonremoved plans per brand, seven weekdays per plan, one occurrence
  per plan per local date, and a maximum 14-day materialization horizon. These
  are workload bounds, not monetary spending caps. Existing hosted generation
  admission and physical-call concurrency enforcement remain authoritative.
- Every dispatch locks and snapshots the configured text provider, model and
  credential revision through the existing shared helper. Changing a key or
  model does not silently retarget an admitted run. Calendar provider-selection
  parity is a prerequisite, including ordinary existing slots.
- No plan approves, schedules delivery, publishes or counts a generated draft
  as read by a human. Existing provenance and approval checks remain intact.

## Time contract

The user supplies ISO calendar start/end dates (end inclusive, at most 366 days
after start), weekdays numbered Monday=1 through Sunday=7, an HH:mm local time,
and a valid IANA zone (UTC accepted). Dates use AD years 0001–9999: PostgreSQL
does not accept the astronomical year zero supported by some date libraries.
A required end date bounds consent; renewal
is an explicit edit and enabling action. The server returns ISO UTC instants,
local dates, zone and offset for upcoming occurrences.

Preview and materialization share one server-side calculator. Choose Luxon
3.7.2 as an explicit dependency of a server-only module: it already occurs in
the workspace lockfile via pg-boss and supplies IANA validation, calendar-day
arithmetic and possible-offset enumeration. Do not add it to browser-importable
`packages/shared`, whose runtime dependencies are deliberately limited to zod.
Temporal polyfill is an alternative, but adds another dependency while the
existing date library covers this bounded weekly contract. References:
[API](https://moment.github.io/luxon/api-docs/index.html),
[MIT license](https://github.com/moment/luxon/blob/master/LICENSE.md).

For a nonexistent local time during a forward DST jump, skip that date and show
the reason in preview/history; never silently shift the requested hour. For an
ambiguous local time, choose the earlier UTC instant exactly once and display
its offset. Calculation compares the resulting local fields with the requested
fields to detect a library-normalized gap. Iterate calendar dates, never add
24-hour durations. Routine scans preserve existing planned snapshots and instants
across tzdata updates. Only explicit re-enabling/revision of an unstarted
suspended occurrence may recalculate it; dispatched snapshots remain immutable.

The planner considers today through the next thirteen local dates, constrained
by start/end. A newly materialized or explicitly replanned instant at or before
the planner's fixed UTC clock is skipped;
there is no historical catch-up after downtime or pause. The UI explains this
behavior. The preview clock is informational: enable replans against server time
and cannot promise an occurrence whose instant has passed.

## Persistence and replay

`editorial_plans` is tenant-owned and brand-owned, with name (1–120 characters),
brief (existing maximum), sorted unique channel IDs, sorted unique weekdays,
local time, timezone, start/end dates, enabled state, monotonically increasing
revision, consent version, consenting actor, consent timestamp, consented revision
and timestamps. Enabled state requires consent for the current revision.
Successful enable/resume increments revision and records fresh consent for that
revision. Dispatched occurrences retain their own immutable consent evidence.
Enable applies only to a disabled plan; repeated Enable refuses without changing
revision or existing snapshots. Repeated Pause/Remove is idempotent and does not
advance revisions. Removed plans remain terminal.
Any schedule, brief, channel or date-range edit disables the plan and clears
active consent; re-enabling requires fresh literal consent. No credentials or
provider secrets are stored in the plan. Removal is terminal (`removedAt`), hides
the plan from active management and refuses further editing/enabling.

`editorial_plan_occurrences` has tenant/brand/plan ownership, immutable local-date
identity and nullable UTC instant, plan revision and by-value brief/channel snapshot,
closed state, optional calendar-slot ID and dispatched-run ID. Unique
`(plan_id, local_date)` survives plan edits and calendar-slot/run deletion.
Calendar slots have immutable recurring occurrence attribution, structurally
scoped to the same organization and brand as the occurrence and plan. Each
occurrence owns at most one active slot; deleting a link never converts that
slot into ordinary calendar work. Calendar slot deletion
must mark the occurrence skipped; run deletion cannot reopen dispatched work.
Deletion of a plan cancels unstarted owned slots and retains a minimal disabled
plan/occurrence tombstone; organization/brand deletion cascades. Removed plans
do not consume the five-active-plan limit. Cap total retained occurrence rows
per brand at 10,000; creating or extending plans refuses on reaching the bound.
Do not silently evict replay tombstones to make room. Future archival needs a
separate retention design.

States are planned, suspended, dispatched, skipped and cancelled. A pg-boss redelivery or a
second planner instance observes the same occurrence identity and cannot create
a duplicate slot or run. The occurrence insert and ordinary slot insert commit
in one transaction. Due dispatch atomically changes occurrence to dispatched
with run creation, pg-boss enqueue and slot linkage.

## Edits, pause and races

Mutation requests include expected plan revision; stale requests receive 409.
Pause, delete or edit locks the plan before its sorted occurrences and unstarted
slots. Pause removes unstarted slots and marks their occurrences suspended.
Already admitted runs continue with their immutable snapshot; users cancel those
through Runs. Resume replans still-future suspended occurrences under renewed
consent, updating the same unique local-date identity. Editing a plan disables
it and suspends future unstarted occurrences; enabling updates matching future
dates with the new snapshot, while removed weekdays stay suspended. Explicitly
skipped and dispatched dates never regenerate. Snapshot/UTC instant may change
only for never-dispatched planned/suspended occurrences under an explicit
revision change; freeze them permanently at dispatch. The UI previews these
consequences before confirming an edit.

Closed reasons include manual_skip, plan_paused, plan_removed, dst_gap,
generation_window_expired, channels_missing, provider_not_configured and
retention_capacity_reached. Missing channels/provider leaves an unstarted
occurrence planned with an actionable blocked reason until fixed or expired;
repair never silently changes its brief or channel snapshot. Retention capacity
refuses new inserts and shows an actionable plan-level reason.
Skipped DST-gap occurrences have null UTC instant and retain the requested local
date/time/zone. Pausing is a normal suspended state; missing configuration is
actionable and cannot silently select another provider.

Calendar slot edit/delete checks recurring attribution and follows the same
plan-before-occurrence-before-slot order. Direct modification of a recurring
slot is refused with a localized instruction to edit/pause its plan; deletion
is allowed as an explicit skip. A slot list shows its plan name and occurrence
state without creating a second plan-management location.

Internal pause/remove slot deletion preserves suspended/cancelled attribution
and does not invoke the ordinary user's manual-skip operation.

The global bounded planner creates slots only. It takes organization SHARE,
brand NO KEY UPDATE, plan UPDATE, occurrence and slot locks in stable order.
Every plan create/extend or materialization that grows retained rows serializes
on this brand lock and checks remaining capacity within its insert transaction.
The five-plan cap is checked on create; the 10,000-row cap is checked on every
new occurrence insertion batch. It never
acquires paid-admission advisory locks while holding child rows. Due dispatch
takes existing paid-admission advisory, hosted admission and organization SHARE,
AI-selection locks, then brand KEY SHARE, plan, occurrence, slot and topic locks. Ordinary slots
retain their existing path after selection locking. All tenant queries use orgId
first and explicit select allowlists. Lock order must be reviewed against current
deletion and calendar writers before implementation.

Calendar update/delete retains its existing brand NO KEY UPDATE lock, then
locks recurring plan and occurrence before the slot. Discover attribution with
an unlocked tenant-scoped read and revalidate it under these locks; never lock
the slot first merely to discover its plan. The dispatcher admits a recurring
slot only when its locked occurrence is planned, matches this slot, has no
dispatched marker, and its plan is enabled with consent for the snapshot revision.
Disconnected, cancelled, removed or skipped recurring slots cannot fall back to
ordinary slot dispatch. Before enqueue, atomically skip occurrences more than
one hour late as generation_window_expired. This also fences already-materialized
overdue slots after downtime or subscription/concurrency recovery; ordinary
calendar lateness behavior remains as currently implemented.

One global pg-boss planning scan (bounded pages, each plan transaction separate)
runs in production; no per-plan cron entries. Enabling may request the same
materializer asynchronously, with a transactional queue record and no separate
provider call. Failure history stores closed reasons, not raw SDK error prose.

## Interface

Recurring plans live in a separate component on the existing brand Calendar,
using shared controls and statuses. Show disabled/enabled/ended status, schedule,
timezone, next occurrences and generation-cost explanation. Save sits beside
its independent form; Enable, Pause and Remove are adjacent to the plan. Require
an explicit confirmation for enabling and for cancellation-bearing edits. All
four locales, keyboard use and mobile layout follow the UX constitution.

## Acceptance

Demonstrate an isolated built-browser journey: create disabled plan, preview,
enable with consent, observe one due mocked generation, review its draft, pause,
skip an occurrence and remove the plan. No external publication or provider call.
Native tests cover timezone/DST gaps and overlaps, leap dates, finite ranges,
tenant/capability refusals, stale revisions, concurrent enable/materialization,
pause/resume/edit-vs-dispatch ordering, brand deletion overlap, late restart and
subscription recovery, deletion/replay fences, transactional enqueue failure,
provider revision pinning and hosted admission. Independent adversarial review
precedes the execution plan; independent guard mutation checks target only new
authorization/replay/consent fences, with three consistent runs.
