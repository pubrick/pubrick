# Publication operations

Open **Brands → a brand → Publications** to inspect each channel adaptation's
current delivery result. The inbox is read-only; actions that can send, retry,
reschedule or cancel a delivery remain on the post's adaptation card. Each row
opens that card directly.

The default **Needs attention** view includes manual publications awaiting a
confirmed link, confirmed failures, deliveries with an unknown outcome, and
partial Telegram deliveries. An unknown delivery may already be live. A partial
Telegram delivery has a confirmed first message and an unresolved reply. Check
the channel before taking any action that could send a second copy. **Scheduled**
shows adaptations still in the `scheduled` state; a job that has moved to `queued` or `publishing` is
visible in **All**. **Published** shows confirmed publication receipts and
human assertions, with the assertion named separately from platform evidence.

The API is `GET /api/brands/:brandId/publications?filter=needs_attention&limit=30`.
It requires an authenticated session with access to that brand. `filter` also
accepts `scheduled`, `published`, or `all`; `limit` is 1–100. The response is
`{ rows, nextCursor }`. Pass `nextCursor` as `cursor` to continue, or stop when it
is null. Ordering is descending by immutable adaptation creation time and ID,
with microsecond precision preserved in the cursor. Each row carries the
current receipt-derived `deliveryOutcome`, a closed failure code, schedule or
publication evidence, and the post and channel identity. Provider error text,
credentials, and frozen partial reply text are not exposed by this list.

This is the operational view of live adaptation rows. Deleting a channel or
brand removes its adaptations, and archived delivery receipts whose adaptation
was deleted cannot be linked back to a post here. The post detail and existing
receipts remain the place to inspect a surviving post's full history.
