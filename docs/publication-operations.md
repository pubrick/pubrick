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

The **Archived receipts** section below the live inbox lists receipt rows from
deleted channels for this brand. It uses a separate read-only endpoint,
`GET /api/brands/:brandId/publications/archive?limit=30`, with a 1–100 limit
and the same opaque microsecond keyset cursor pattern. A receipt has no live
adaptation link: the section shows only the closed receipt status, channel name
and platform stamped at deletion, external URL, assertion time, and record time.
`in_flight` means unconfirmed after the channel went away, never a confirmed
publication. Only HTTPS external URLs become links. Provider errors, partial
reply text, credentials, and dead post actions never enter this response.

The database stamps nullable `publications.brand_id` in the existing
`BEFORE DELETE` channel tombstone trigger, before the foreign keys clear channel
and adaptation pointers. Live rows retain a null snapshot until deletion; a
large upgrade-time rewrite is unnecessary. Receipts orphaned before this
feature cannot be assigned to a brand safely and stay out of brand archives.
The archive requires an existing brand in the active organization. Deleting a
brand makes its receipts inaccessible through this route, even though the
tenant-owned historical rows remain until the organization itself is erased.
