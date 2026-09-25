# Automatic Telegram story comment collection

Pubrick can collect a small reply sample for relevant **public** Telegram stories. A member with access to a brand enables it on that brand's Sources page. It is off by default. The workspace must have a connected Telegram account; private sources and publications are outside this setting.

The hourly worker considers active public Telegram sources only. A story must have been published at least six hours earlier, have a raw model relevance score of at least `0.7`, and never have had a comment check. Each scan queues at most 50 stories per brand and 10 brands (500 stories) globally. Brands are visited by oldest previous scan, so a large workspace cannot monopolize the scan. A repeated scan in the same hour may visit other brands; the 500 limit applies to each scan, while each brand has a one-hour gate. The Telegram reader samples at most 50 replies per story. Each story can be sampled once automatically; an editor can still request a manual refresh.

Collection reads Telegram only. Paid Gemini analysis is a separate step. A
brand manager may separately enable automatic paid analysis of new, nonempty
automatic samples, subject to workspace and brand daily admission thresholds.
The worker also requires `PAID_REPLY_DISPATCH_AFTER` so an upgrade never buys
analysis for old samples. See [Paid reply analysis](paid-reply-analysis.md).

Each queued automatic job carries the brand setting's revision. The worker checks the current opt-in, revision, source state, story age, raw score, and sample status before Telegram I/O and again inside the save transaction. Turning the setting off, even briefly before turning it back on, invalidates older jobs. An already started Telegram request can finish after opt-out, but its response cannot be saved. The final save locks the setting row, so an opt-out waits for an in-progress save transaction and takes effect immediately afterward.

Automatic enqueue leaves the story unchecked until the worker records a result. A lost or rejected job can be queued by a later scan. The queue's per-story singleton prevents duplicate concurrent work, while the final `commentsCheckedAt IS NULL` check prevents duplicate sample writes. A Telegram access error is saved as a failed check and requires a manual refresh after the account or source is repaired.

The setting API is `GET/PUT /api/sources/comment-collection?brandId=<uuid>`, scoped to the active organization and brand. `PUT` accepts only `{ "enabled": boolean }`; every update increments the revision. The API does not expose the Telegram session or any reply author identifiers.
