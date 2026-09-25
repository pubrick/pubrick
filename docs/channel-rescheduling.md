# Reschedule one channel

The review screen also offers **Approve, send in 30 min** for an unsent draft
with automatic channels. It records a human approval and schedules the channels
30 minutes from the database clock using the existing transactional approval path. It
never approves a draft automatically, and the reviewer can still choose an
exact time. This shortcut is unavailable for manual channels and posts already
in delivery; use the per-channel action below to move an existing slot.

A reviewer can move one scheduled automatic channel from the post's Results
section. The **Reschedule** action is secondary to publishing and appears only
on a scheduled adaptation. The form shows the browser's local time and sends
ISO timestamps to the API. Save and Cancel leave other channels alone.

An approved post with at least one scheduled channel also shows **Before
delivery** on its detail screen. This read-only report uses the already loaded,
organization-scoped post and channel data. Per scheduled channel it displays
the saved text length against the current platform limit (including Telegram's
video caption limit), the selected attachment type and whether that type is
supported, and whether the slot is future, due within the shared dispatch
window, or overdue. Missing channel data is explicitly unknown. It makes no
extra request, writes nothing, and never approves, cancels, or sends a post.
The report reflects the current browser snapshot; after an overdue warning,
reload to confirm the outcome before changing the schedule. Passing these
checks does not verify credentials, file access, or platform acceptance;
the actual delivery still decides the outcome. AI quality scores and similarity are
not delivery facts and are not part of this report.

`POST /api/content/:id/adaptations/:adaptationId/reschedule` accepts
`{ "expectedScheduledAt": "...", "scheduledAt": "..." }`. Both values are ISO
instants. The expected value is the time the reviewer saw; a changed value
returns `schedule_changed` so an old tab cannot silently overwrite a teammate's
move. The route is organization and brand scoped and also requires the
adaptation to belong to the URL's item.

Only an approved post's scheduled automatic adaptation can move. A retry with
earlier known failures can move, including one whose unknown outcome a person
resolved as not delivered. A published receipt, an in-flight claim, or an
unknown outcome without a later human not-delivered assertion blocks the move.
Both the current slot and the requested slot must be more than one minute away
by the database clock; a past request is refused because pg-boss would dispatch
it immediately. A queued, publishing, published, failed, manual, rejected, or
archived delivery cannot be moved through this route.

The API holds the adaptation lock used by the publish worker. In one database
transaction it cancels the selected channel's old job, advances its attempt
count (the cancelled pg-boss id remains), changes `scheduled_at`, and enqueues
the replacement. An enqueue failure rolls everything back. The worker also
matches the job's expected scheduled time when claiming the adaptation, so an
old active job cannot deliver the moved slot early. The content item's status,
approval journal, and sibling jobs do not change.
