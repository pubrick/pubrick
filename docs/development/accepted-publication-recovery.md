# Accepted records and human delivery resolution

A provider may accept a record without publishing it. For example, a post may
remain pending, private or a draft. Pubrick preserves the worker's server-owned
ID and inspection URL in an `unknown` publication receipt. It does not mark that
record published, create another copy, or retry the provider call.

Content detail exposes `deliveryReceipt` only for the latest finished unknown
receipt of the adaptation's current attempt. Published `externalUrl` remains a
separate field. Older receipts do not reappear after a human resolution or a
new attempt. Queue summaries omit the detail-only receipt.

An editor inspects the provider record, then records one of two decisions:

- Delivered: append a human publication receipt with the server-owned ID and
  URL, together with who asserted delivery and when. This is a person's
  confirmation; it does not claim the provider confirmed publication.
- Removed: explicitly confirm the retained record was removed at the provider.
  Append a failed human receipt; another send becomes available. Pubrick does
  not remove the provider record or send anything during this decision.

Both decisions send `expectedReceipt: { id, attempt }`. The endpoint checks it
after taking the organization and adaptation locks, using a new read after any
lock wait. A missing or changed identity produces `delivery_receipt_changed`
and writes nothing. The optional DTO field lets older clients receive this
coded reload refusal; omission never authorizes reconciliation. Telegram partial
recovery retains its separate full-completion/removal acknowledgement. Manual
publication confirmation uses its existing, separate endpoint.

Accepted-record removal also requires `acceptedResolution: "removed"`.
Client-supplied provider IDs or URLs are not evidence and are never copied.

Late provider acceptance for an already human-settled attempt remains attached
to its original historical worker claim. It does not overwrite the human
verdict or fill a newer attempt's link. The delivered receipt copies acceptance
metadata known when the editor resolves it; later historical enrichment is
visible in the read-only archive after channel deletion. Pubrick does not
currently expose a per-attempt history for a live channel.
