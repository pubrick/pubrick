# Reschedule one channel

A reviewer can move one scheduled automatic channel from the post's Results
section. The **Reschedule** action is secondary to publishing and appears only
on a scheduled adaptation. The form shows the browser's local time and sends
ISO timestamps to the API. Save and Cancel leave other channels alone.

`POST /api/content/:id/adaptations/:adaptationId/reschedule` accepts
`{ "expectedScheduledAt": "...", "scheduledAt": "..." }`. Both values are ISO
instants. The expected value is the time the reviewer saw; a changed value
returns `schedule_changed` so an old tab cannot silently overwrite a teammate's
move. The route is organization and brand scoped and also requires the
adaptation to belong to the URL's item.

Only an approved post's scheduled automatic adaptation can move. A channel
with a delivery receipt must be inspected before scheduling it again. Both the
current slot and the requested slot must be more than one minute away by the
database clock; a past request is refused because pg-boss would dispatch it
immediately. A queued, publishing, published, failed, manual, rejected, or
archived delivery cannot be moved through this route.

The API holds the adaptation lock used by the publish worker. In one database
transaction it cancels the selected channel's old job, advances its attempt
count (the cancelled pg-boss id remains), changes `scheduled_at`, and enqueues
the replacement. An enqueue failure rolls everything back. The worker also
matches the job's expected scheduled time when claiming the adaptation, so an
old active job cannot deliver the moved slot early. The content item's status,
approval journal, and sibling jobs do not change.
