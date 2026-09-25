# Block a draft's source topic

An author, editor, or existing workspace member can open an unpublished draft
made from a saved topic and choose **Block topic and archive draft**. A required
reason (1–500 characters) is recorded on the topic. The confirmation explains
both effects before the request is sent. The action is available only when the
content detail response contains a proven `topicId` and the item is a draft or
rejected post.

`POST /api/content/:id/block-topic` performs the topic block and draft archive
in one transaction. It checks the active organization, brand, topic link,
delivery state, and current draft status under ordered locks. A stale or
unlinked item returns a coded refusal and neither change is committed. The
topic receives the same blocked state, reason, timestamp, and revision change
as the Topics screen. Existing calendar workers reject a stale or blocked
topic before creating a run. Existing exact-title suppression uses the blocked
topic; optional semantic suppression remains subject to its separate setting
and metered embedding workflow.

The run's nullable `topic_id` records direct topic generation, calendar topic
generation, and autopilot generation. The migration backfills links where a
historical calendar slot or autopilot dispatch proves the topic and tenant.
Older direct runs have no durable topic ID and are left unlinked; their drafts
do not offer this action. Deleting a topic clears its run link, preserving the
run and draft without making up provenance. Archived drafts can be restored;
the blocked topic remains blocked until a separate unblock decision returns
it to an idea that requires approval again.
