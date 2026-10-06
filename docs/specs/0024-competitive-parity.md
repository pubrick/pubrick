# Competitive product parity

Owner direction: 2026-10-06. English-first open-source and hosted product;
payments remain deferred. This specification defines acceptance rather than
claiming that a feature count establishes competitive parity.

## Product baseline

A creator or small editorial team connects destinations, brings its sources
and brand rules, produces and reviews content, plans delivery, and understands
what happened. Existing generation plans, review gates, delivery receipts and
tenant isolation remain the foundation. Publication requires human review of
the actual saved content; approval of a strategy never approves future text.

Official reference workflows: [Buffer posting schedules](https://support.buffer.com/en-us/articles/setting-up-your-timezones-and-posting-schedules-P4iSag90Fl),
[SocialBee Copilot](https://help.socialbee.com/hc/en-us/articles/29979132682391-Social-Media-Copilot-All-You-Need-to-Know),
[ContentStudio](https://contentstudio.io/features), and [Postiz](https://postiz.com/).
These are documented vendor capabilities, not results of testing their accounts.

| Area | Existing foundation | Required product outcome |
| --- | --- | --- |
| Entry and navigation | Identity, workspaces, brands, setup forms | A discoverable next action, clear workspace/brand context, actionable connection errors and saved state |
| Composer | Master rich text, channel adaptations, media, history | Efficient channel switching, accurate previews and limits, no loss of unsaved input |
| Planning | Generation calendar, finite weekly generation plans, timed approval and individual rescheduling | Per-channel recurring publication slots, next-slot preview and explicit approval, readable upcoming queue and safe reorder/reschedule |
| Team review | Roles, invitations, guest links, notes | Fast review navigation and batch management of visible prepared items, mobile and keyboard access |
| Native destinations | Telegram, VK, MAX, Bluesky, Mastodon | LinkedIn, WordPress, Meta Instagram/Facebook and Threads, each with explicit credential, media and API access limits |
| Results | Delivery receipts, costs, VK metrics | Supported per-post/channel results, comparison periods and exports without invented or unavailable metrics |
| Inbox | Bounded Telegram comment collection | Unified supported conversations, read/resolve state and explicit replies with durable send evidence |

## Publication queue design

Recurring publication slots differ from recurring generation plans. Saving a
weekly channel schedule does not create content, spend tokens, approve or send.
An editor explicitly adds a reviewed content item to its next available slots.

Each native channel has an optional IANA timezone and a bounded list of unique
weekday/HH:mm slots, with a persisted revision. No seeded times or implicit
opt-in. A missing schedule offers configuration; manual handoff destinations
cannot enter an automatic queue.

The server calculates future instants with the maintained Luxon dependency
already used for editorial plans. Nonexistent DST times are skipped; repeated
times use the earlier instant once. Calculation has a bounded horizon and
exposes exhaustion. Scheduled, queued and publishing retry-chain deliveries
with retained times occupy their channel slots until terminal or resolved.
Failed, cancelled or historical deliveries do not occupy future slots.

A preview names every destination and its exact local time, timezone and UTC
instant. Confirmation must refuse changed content, changed settings, occupied
times or changed delivery states; it cannot silently choose a different time.
The confirmed schedule and existing pg-boss publish jobs are written together
under a shared publication scheduling advisory lock and existing
content/adaptation locks. Existing timed approval and reschedule writers take
the same advisory lock before adaptations and validate occupied instants.
No separate in-memory queue, approval shortcut or delivery adapter is added.
Use the database clock after lock waits for expiry and minimum lead checks.
The versioned token is purpose-, tenant- and item-bound and snapshots master
revision/rich text/media and exact adaptation text, tags, delivery state and
attempt counts. Initial queue approval accepts unsent native-only items;
manual, scheduled, active and historical delivery use their existing actions.
Credential replacement does not itself move approved jobs, but changing a
channel's posting schedule always advances its revision, including ABA edits.
Repeated confirmation cannot enqueue duplicate sends. Uncertain and partial
delivery histories keep their existing reconciliation requirements.

Saving new posting slots affects subsequent additions. Existing approved jobs
keep their original instants until an editor explicitly reschedules them.
Reordering is an explicit change of future delivery times, with stale-state
checks and the existing minimum lead time; it must also support keyboard/touch
controls. The upcoming queue uses server-side chronological pagination by
scheduled instant and adaptation ID, not sorting individual fetched pages.
A generation calendar entry is never represented as a publication.

## User acceptance

Use maintained transport fixtures for automated browser journeys and real
platform test accounts for live integration acceptance when credentials are
available. Never describe a fixture result as real platform acceptance.

The core journey covers account/workspace, brand and channel connection,
source-based content, channel edits, explicit review, next-slot confirmation,
upcoming queue, rescheduling and a persisted delivery receipt. Test error
recovery and a second workspace, including stale previews and concurrent edits.
Desktop and narrow-screen layouts must expose primary actions, readable states,
labels and keyboard focus. Localized refusals name a practical recovery action.
Every approval and slot-preview control refuses while the editor contains
unsaved changes or a save is in progress, with a visible save recovery action.

API permission, app-review or account prerequisites are documented as external
acceptance gates. Implement all locally testable behavior without inventing
platform capabilities or bypassing provider restrictions. Hosted domain/mail
and payment setup do not block self-hosted product work.

Instagram's existing manual channels remain manual. Native Instagram requires
an explicit connection mode or a distinct platform ID; migrating credentials
must not silently convert previously approved manual handoffs. The current
publisher accepts text and a single JPEG/MP4; carousel, public-media and async
platform-container support require explicit capability contracts. Public
WordPress endpoints follow the existing outbound HTTPS and redirect policy.

## Delivery discipline

Track implementation and dependencies in Beads. Integrate coherent vertical
slices; focused tests during implementation, one combined review and integrated
local gate per milestone, then only affected checks for minor fixes. Each
milestone records what works, test evidence and actual remaining limits. Update
the public capability inventory only when the corresponding implementation lands.
