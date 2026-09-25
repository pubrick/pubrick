# Undoing an unsent approval

`POST /api/content/:id/retract-approval` returns an approved post to the draft
queue when none of its deliveries has started. The item and all of its channel
adaptations are checked under the publishing lock order. Any queued or scheduled
publish jobs are cancelled in the same database transaction that resets the
adaptations to `pending`; their attempt counters advance so a later approval
gets fresh job IDs.

The endpoint refuses a post with a recorded delivery attempt, a publishing or
published adaptation, or an erased adaptation history. A `manual_ready` VC.ru
post is also refused: it may already be live outside Pubrick before its URL is
recorded here. The endpoint refuses when the item is no longer approved. A
refusal changes neither the post nor its jobs.
The visible **Undo approval** action is offered only while the saved state
looks unsent; the server rechecks it because a worker may claim a job after the
screen loads.

Undoing approval does not erase the historical human approval decision. It
does not record a rejection either: rejection is a different editorial verdict.
The existing **Reject** action remains available when an attempted or partly
delivered post still has outstanding channels to stop.
