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
topic-bank links, recurring plans, holiday suggestions, and a separate
explicit opt-in schedule for publication. The old Content Factory's autopilot
guardrails and AI calendar planner are not implied by this first slice.

## API

- `GET /api/calendar/slots?brandId=<uuid>&from=<ISO>&to=<ISO>`: up to 93 days,
  half-open interval.
- `POST /api/calendar/slots`: `brandId`, `scheduledAt`, `brief`, `channelIds`,
  optional `notes`.
- `PATCH /api/calendar/slots/:id?brandId=<uuid>`: change a planned slot.
- `DELETE /api/calendar/slots/:id?brandId=<uuid>`: remove a planned slot.

Every route requires an active organization. The repository scopes all reads
and writes by organization and brand and returns only explicit public columns.
