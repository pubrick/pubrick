# Planned generation calendar

The calendar is a brand-scoped plan for **draft generation**. A slot contains a
future local date and time (stored as an absolute timestamp), a brief, one or
more of the brand's channels, and optional team notes. The month grid shows the
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

The generated draft follows the existing human review gate. Scheduling a slot
does not approve or publish content. Operators can open the run receipt from
the calendar after it starts. A slot already linked to a run is immutable; the
run's cancellation and review controls remain on the run and content screens.

The scanner processes up to 100 due slots per minute. Future work can add
topic-bank links, richer recurring plans, and a separate explicit opt-in
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
- `POST /api/calendar/slots`: `brandId`, `scheduledAt`, `brief`, `channelIds`,
  optional `notes`.
- `PATCH /api/calendar/slots/:id?brandId=<uuid>`: change a planned slot.
- `DELETE /api/calendar/slots/:id?brandId=<uuid>`: remove a planned slot.

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
