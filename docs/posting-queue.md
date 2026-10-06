# Weekly posting times and next-slot queue

Open a brand's channel list and choose **Posting times** beside an automatic
channel. Owners, administrators and editors can configure it; manual channels
keep their manual preparation workflow.

Choose an IANA time zone such as `Europe/London`, then add weekday/time pairs.
Save is beside this form. Empty settings mean there is no automatic queue for
that channel. Saving settings does not approve content or move existing jobs.
During daylight saving changes, nonexistent local times are skipped and a
repeated local time is used once, at its earlier occurrence.

On an unsent post, review the master text and each channel's prepared text,
tags, call to action and media. Save any edits first. **Add to queue** previews
the next free time for every automatic destination, independently. The preview
creates no publication jobs. Confirm with **Approve** to approve this saved
version and schedule exactly the times displayed. The existing AI read/edit,
generated-image review and client approval requirements still apply.

A preview lasts ten minutes and requires at least one minute before its times.
If content, weekly settings or slot availability change, confirmation refuses
the stale preview. Reload, review the actual saved content and preview again.
The API never silently substitutes a different time. Unknown outcomes, partial
delivery and previously attempted posts use their existing recovery controls.

The brand's publications screen shows scheduled deliveries in ascending
publication time. The review list shows each channel's scheduled time and the
browser's time zone. Use **Reschedule** on the post to move an existing channel;
see [rescheduling safety](channel-rescheduling.md).

## API contract

- `GET /api/channels/:id/posting-schedule` returns public time-zone, slot and
  revision settings, without channel credentials.
- `PUT` to the same path accepts `{expectedRevision, timezone, slots}`. Each
  slot is `{weekday, localTime}`, where weekday is ISO Monday `1` to Sunday `7`
  and time is `HH:mm`. At most 70 unique pairs are accepted. A stale revision
  returns `schedule_changed`.
- `GET /api/content/:id` includes `postingReviewFingerprint` for the saved
  publication inputs that this review screen loaded.
- `POST /api/content/:id/posting-queue/preview` accepts that `reviewFingerprint`.
  It returns an opaque ten-minute token and the exact destination times.
- `POST /api/content/:id/approve` accepts `{queuePreviewToken}` instead of an
  absolute or relative time. Rows and jobs commit in the same transaction.
  The web also sends `expectedReviewFingerprint` with immediate and timed
  approval to refuse any unseen saved change. That field remains optional for
  older clients; those clients retain the existing server review gates but
  do not receive the new saved-version conflict protection.
- `GET /api/brands/:id/publications?filter=scheduled` pages by
  `(scheduled_at ASC, adaptation_id ASC)` with a `pq1.` cursor. Other filters
  retain their existing creation-time cursor. Cursors cannot switch modes.

These new writes require a workspace session with editor capability and brand
access. They do not add a public API-key approval permission. Slot search is
bounded to 90 local days. Occupied scheduled, queued and publishing times are
excluded, including times created by existing timed-approval and rescheduling
actions. See [lock order](lock-order.md#publication-posting-admission).
