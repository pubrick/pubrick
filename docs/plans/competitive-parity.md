# Competitive parity delivery plan

Date: 2026-10-06. Specification: [product acceptance](../specs/0024-competitive-parity.md).
The owner approved autonomous implementation. Payments remain deferred.
Implementation and completion are tracked in Beads epic `Ozon-tools-zib2q`;
this document describes dependencies and acceptance, not a second task tracker.

## Sequence

| Milestone | Scope | Acceptance and dependency |
| --- | --- | --- |
| 1 — Daily review and safe scheduling | Save before approval, queue keyboard navigation and readable delivery times; per-channel weekly posting settings, next-slot preview/confirmation, chronological upcoming publications | Built browser journey through editing, saved text, exact slot confirmation, stale-state recovery and persisted jobs; mobile/keyboard controls; preserves existing approval and delivery fences |
| 2 — Composer and calendar | Retained per-channel edits, clear saved state, media capability previews; publication calendar and atomic multi-delivery moves | Uses milestone 1 scheduling contract; touch/keyboard alternative to drag; no generation entry mistaken for a publication |
| 3 — International native destinations | LinkedIn and WordPress first; native Instagram/Facebook and Threads after connection/media contract | Official API requirements recorded, fixture transports verified, real test-account acceptance separately recorded; existing manual channels preserved |
| 4 — Team review | Assignments, fast visible-item review, bounded batch management, mobile guest review | Reviews actual prepared versions, maintains brand permissions, refuses stale or unread approvals; no unseen future content consent |
| 5 — Results | Capability-based per-post/channel metrics, periods and exports | After native platform contracts; absent metrics stay absent, receipt/cost semantics remain explicit |
| 6 — Supported inbox | Normalized conversations, read/resolve state, explicit replies and send receipts | After platform read/reply permissions and cursor contracts; no automated reply or unsupported message access implied |

Milestones 1 and 2 form the first coherent core-workflow release. Later platform
adapters may run independently after their shared contract lands. Keep
independent implementation checkouts and serialize heavy verification.

## Decisions from specification review

The review found a concrete existing bug: unsaved text can be visible in the
editor while approval sends older saved text. Fix this before next-slot UX.

Organization `FOR KEY SHARE` is not scheduling serialization. Existing timed
approval and rescheduling need the same publication admission lock as queue
confirmation, acquired before adaptation locks. Preserve the documented
adaptation → channel → item order. Schedule-setting changes do not retime
existing jobs; preview expiry and future lead time use the database clock.

The publication operations API currently pages by creation time. Upcoming
delivery must have its own scheduled-time order/cursor contract; a browser
sort is insufficient. The generation calendar remains a generation plan.

Instagram manual/native migration and asynchronous media capabilities precede
Meta adapters. Do not advertise API/MCP, OAuth, analytics or inbox capability
by a platform name alone. API app approval and live credentials are external
acceptance prerequisites, not substitutes for implementing testable behavior.

## Verification cadence

Focused behavioral and database tests while implementing a slice; one combined
review, typecheck, lint and full local test gate per integrated milestone.
Use a disposable database; preserve the owner's retained local database and
other active projects. Built browser acceptance uses owned transport fixtures,
followed by available real provider test accounts with explicit receipts.
Record evidence once per reviewed source, and rerun only affected checks for
minor corrections. Publish meaningful feature milestones, keep the goal open
while required work remains, and record concrete external launch prerequisites.

## Implementation evidence

The selected contracts of all six milestones are implemented. Core review,
scheduling, composer and calendar acceptance is recorded in
[core workflow evidence](../verification/competitive-parity-core.md).
WordPress/LinkedIn, team review, results/CSV and the supported Telegram Inbox are
recorded in [native/team/results/inbox evidence](../verification/competitive-parity-native-team-results.md).
The remaining native Meta connection/media/readiness and recovery contract is
recorded in [Meta evidence](../verification/competitive-parity-meta.md).
These reports state the supported formats, metrics and permissions; they do
not claim broader platform coverage or live provider approvals. Payments remain
deferred, and public hosted launch has separate domain/mail/operations acceptance.
