# Paid analysis of Telegram replies

Pubrick keeps reply collection and Gemini analysis as separate actions. Opening
a source story or publication panel only reads saved data. A manual **Analyze**
request queues one paid Google BYOK analysis of the newest 30 saved replies,
using at most 500 characters from each. **Check result** only rereads that
attempt. A saved aggregate reports sentiment, themes, and feedback for the
sample; it is not a count or description of the whole audience.

The queue admits at most one attempt per reply-row version. A failed or
uncertain dispatched call is not retried for the same version, because the
provider may already have charged for it. A newer collection can create a new
version. The panel shows a previous ready aggregate under **Earlier sample**
while the current version is empty, pending, failed, or unanalyzed.

## Optional automatic analysis

Automatic analysis has its own default-off consent, separate from free
automatic collection. Managers enable it per brand on **Sources** for watched
Telegram stories and on **Results** for the brand's own published Telegram
posts. Only a new, nonempty, successful *automatic* collection can hand off to
paid analysis. Manual collections, historic samples, inaccessible discussions,
and empty/error checks do not trigger it. The workspace needs a saved Google
key and daily admission settings in **Settings**. Self-hosted workers also
require `PAID_REPLY_DISPATCH_AFTER` set to the rollout instant; leaving it
unset disables automatic paid dispatch, even if a brand switch is on. Set an
instant with `Z` or an explicit UTC offset and restart the worker. Earlier
handoffs are never purchased retroactively.

Each attempt counts the exact frozen provider request before dispatch. Pubrick
reserves a conservative estimated maximum against the workspace and brand
daily admission thresholds and enforces a shared rolling limit of ten analyses
per hour. These are admission controls, not a guarantee about the provider's
invoice. Unknown prior usage or an unknown model price blocks new purchases
for the affected day. A worker commits a one-call fence before contacting
Gemini and records usage before storing a result. Deleting a story, publication,
or brand immediately clears its encrypted prompt; a call that may have been
dispatched retains its uncertain reservation.

For the field-level API, cost, and recovery contract, see
[Paid reply analysis spec](specs/0002-paid-reply-analysis.md).
