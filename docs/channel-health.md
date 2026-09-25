# Channel connection health

Automatic channels have a cached connection check. The worker checks at most
five due channels every 15 minutes, serially, through the same publisher
`verify` method used by **Test connection**. A result is current for six hours.
Reading the channel list or queue never contacts a platform. Manual VC.ru
channels have no connection check.

The channel list shows **Checked OK**, **Last check failed**, or **Not checked**.
A failed result means the last check found an unusable connection or permission;
it does not assert that a token expired. Timeouts, transport failures, unknown
outcomes, and malformed platform responses are inconclusive and appear as
**Not checked**. The attempted time is still saved, so unavailable platforms
cannot monopolize each scan. The UI cannot promise an expiring-soon badge:
current adapters do not provide an expiry instant.

Only the boolean verdict and attempted time are stored. Provider messages and
credentials are not stored in the health cache or returned by `GET /api/channels`.
The manual **Test connection** response still gives its immediate reason to
the person who pressed it. Replacing credentials clears the cached verdict in
the same update. A slow check can save only if the encrypted credential bytes
still match its starting snapshot, so an old token cannot turn a new one green
or red.

The channel list counts its `scheduled` adaptations. When a current check
failed, the queue shows that count and links to the brand's channel controls.
Unknown and stale checks do not create a failure warning. The count is an
exposure signal, not a forecast: queued or publishing jobs are already moving,
and the publish worker makes the delivery decision when each job runs. Health
checks never cancel, approve, reschedule, or publish a post.
