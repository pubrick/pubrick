# Planned generation calendar

The calendar is a brand-scoped plan for **draft generation**. A slot contains a
future local date and time (stored as an absolute timestamp), a custom brief or
an approved topic from the same brand, one or more of the brand's channels,
an optional Gemini cover image, and optional team notes. The month grid shows the
plan; the selected day's list allows edits or removal until generation starts.
On narrow screens a date picker replaces the seven-column grid so every date
target remains large enough to tap. The brand page links to its calendar.

At the scheduled time, a pg-boss tick scans due slots. It takes the same
per-organization advisory admission lock as `POST /api/runs`, checks the limit
of three live runs and revalidates channel ownership. A successful tick inserts
the `pipeline_runs` row, enqueues the existing `generate` job, and stores the
run ID on the slot **in one database transaction**. Another tick cannot create
a second run for that slot. If the organization is at its concurrency limit,
the slot stays planned and is retried five minutes later. A removed channel
sets an explicit error on the slot; editing it with a valid channel clears the
error. A database or queue outage rolls back the transaction and the next tick
can retry.

Cover generation is unchecked by default and requires a saved Google AI key
and channels that support image covers. The slot keeps this choice through
edits and shows it in the calendar. At the due time, the scheduler counts
image calls in the last hour and live runs already reserving covers under the
same organization admission lock as manual runs. If the 12-call budget is full,
it retries the slot five minutes later. The worker rechecks the budget before
calling Gemini; a missing key, full budget, or image failure leaves the text
draft available for review. A successful cover is attached to that draft, not
published automatically. A dispatched image call is billed to the user's key;
see [media library](media-library.md) for accounting and retry limitations.

The topic bank's **Schedule** action opens the calendar with that approved
topic selected. The calendar form can also pick any approved topic. The API
reads and locks the topic in the slot transaction, checks its organization,
brand, and approval, and stores its title, description, source URL, and revision
timestamp alongside the link. It derives the brief from that snapshot; a client
cannot override it with a second brief. Before creating a run or enqueueing a
job, the due worker locks the topic and checks that it is still approved and
matches the complete snapshot. An archived, edited, or missing topic sets
`topic_changed` on the slot and spends no model tokens. An editor can reselect
an approved topic to refresh the snapshot, or explicitly unlink it and write a
custom brief. Editing a linked slot's brief without unlinking is refused.

For a larger plan, editors can select up to 20 approved topics, set a future
date and time for each, review the proposed rows, and confirm one bulk request.
Every row uses channels from the same brand. The API validates the full batch
and creates all slots in one transaction, so a conflict or stale topic leaves
the calendar unchanged. A topic can appear only once in a batch. The bulk
action also refuses a topic that already has a calendar slot; existing
single-slot actions keep their current rules. This action creates planned draft
generation slots; it does not start a run or approve publication.

An owner or admin can also enable **Plan approved dated topics automatically**
in Autopilot settings. The worker then scans hourly and places approved topics
with target dates in the next 14 local days at 10:00 in the brand's time zone.
It respects the selected channels and daily slot limit, counts manually added
slots against that limit, and leaves unapproved or past-dated ideas untouched.
The settings page also offers **Plan now** after the opt-in is saved. This
queues the same idempotent planner, with a 60-second per-brand cooldown; it
does not start generation or publication. Removing or unlinking a slot clears
its topic's target date. A linked topic's date and priority cannot be changed
until its unstarted slot is removed.

Deleting a topic with any linked calendar slot is refused, including after a
slot starts. This preserves the original approval trail; remove unstarted
slots or keep the topic as an archive. A started slot remains immutable.

The generated draft follows the existing human review gate. Scheduling a slot
does not approve or publish content. Operators can open the run receipt from
the calendar after it starts. A slot already linked to a run is immutable; the
run's cancellation and review controls remain on the run and content screens.

The scanner processes up to 100 due slots per minute. Future work can add
richer recurring plans and a separate explicit opt-in
schedule for publication.

## Memorable dates

Each brand can maintain its own annual editorial dates. A date has an `MM-DD`
month and day, a title, 0–365 lead days, optional suggested content formats,
and an active switch. The calendar shows active dates on their occurrence day
and during their lead window. Dates are **suggestions only**: adding or editing
one never creates a topic, run, draft, or publication. There are no built-in
brand-specific dates or automatic seeds.

The brand's configured IANA timezone is shown with these dates; until a brand
configures one, the zone is UTC. Calendar day arithmetic uses the date label,
so a suggestion does not drift when an editor opens the UI from another zone.
February 29 appears only in leap years, with no February 28 substitute. Lead
windows cross New Year and the next actual occurrence is used. For example,
January 1 with a 14-day lead appears from December 18 of the previous year.

The secondary **Manage dates** control opens the CRUD panel. The calendar's
primary Add action still plans a generation slot.

## API

- `GET /api/calendar/slots?brandId=<uuid>&from=<ISO>&to=<ISO>`: up to 93 days,
  half-open interval.
- `POST /api/calendar/slots`: `brandId`, `scheduledAt`, `channelIds`, optional
  `notes`, `generateCover` (defaults to false), and either `brief` or an approved
  `topicId` in that brand. The API rejects a request containing both `topicId`
  and `brief`.
- `POST /api/calendar/slots/bulk`: `brandId` and `slots` (1–20 entries with
  `topicId`, the approved topic's `expectedTopicRevision`, `scheduledAt`, and
  `channelIds`). All topics must be distinct, approved, unchanged since the
  confirmation preview, and part of that brand. A failed row rejects the
  entire batch; successful responses return the created slots.
- `PATCH /api/calendar/slots/:id?brandId=<uuid>`: change a planned slot.
  `topicId: null` plus `brief` explicitly unlinks a topic; a new `topicId`
  snapshots the currently approved topic again. `generateCover` can be changed
  until generation starts.
- `DELETE /api/calendar/slots/:id?brandId=<uuid>`: remove a planned slot.
- `POST /api/brands/:brandId/autopilot/plan-topics`: owner/admin request to run
  the saved, opt-in dated-topic planner now. Returns 202 when queued or 409
  when the feature is off or was requested within 60 seconds.

Every route requires an active organization. The repository scopes all reads
and writes by organization and brand and returns only explicit public columns.

- `GET /api/calendar/memorable-dates?brandId=<uuid>`: returns `{ timezone, dates }`,
  including inactive dates for management.
- `POST /api/calendar/memorable-dates`: required `brandId`, `monthDay`, `title`,
  `leadDays`, `suggestedContentTypes`, `isActive`.
- `PATCH /api/calendar/memorable-dates/:id?brandId=<uuid>`: change one or more
  fields of a date in the requested brand.
- `DELETE /api/calendar/memorable-dates/:id?brandId=<uuid>`: remove that date.

These routes also require an active organization. All four methods check both
organization and brand; a foreign brand/date returns 404.
