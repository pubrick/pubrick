# Telegram publication reply samples

The brand Results screen offers **Reply sample** only on published Telegram
rows. This is separate from channel-reported comment counts in publication
metrics: a sample contains at most 50 readable text replies, may omit short or
duplicate replies, and is never presented as the total number of comments.
Authors are not shown. The optional AI summary reads the newest 30 saved
replies and at most the first 500 characters of each reply, so it may cover
less than the list visible in the sample modal.

Opening the sample reads the saved result. **Collect replies** requests a new
background check for the selected publication; **Check result** rereads a
pending check without reloading the page or making another collection request.
One collection request per publication is allowed every 15 minutes, counted
from its saved request time. The UI shows that cooldown even after reopening
the sample, and the API enforces it. The screen distinguishes a pending
check, a saved sample, no readable replies, an inaccessible discussion, and a
failed check. The Collect action is hidden when the API says the publication
link is unsupported. A public link whose discussion was temporarily unreadable
can be retried after the cooldown. If an older sample survives a later failure, the screen labels
it as an earlier sample.

The same modal has a separate **AI analysis of replies** section. Opening it
reads only the saved analysis; it never invokes a model. **Analyze sample**
is an explicit, paid action using the workspace's Google AI key. The section
explains that it summarizes the newest 30 saved replies, up to 500 characters
from each, never the publication's
total comment count, and asks the reader to inspect the sample before acting.
It shows sentiment, recurring themes, audience feedback, sample size, and the
analysis time. A changed reply sample marks the previous analysis stale and
offers another explicit analysis. Missing keys link to Settings. While an
analysis is in progress, **Check analysis result** rereads saved state without
starting another model call.

Only the organization-scoped analytics endpoints serve this data. The browser
never calls Telegram or Google AI directly.
