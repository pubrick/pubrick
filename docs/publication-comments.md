# Telegram publication reply samples

The brand Results screen offers **Reply sample** only on published Telegram
rows. This is separate from channel-reported comment counts in publication
metrics: a sample contains at most 50 readable text replies, may omit short or
duplicate replies, and is never presented as the total number of comments.
Authors are not shown.

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

Only the organization-scoped analytics endpoints serve this data. The browser
never calls Telegram directly. No AI analysis is run or billed by this feature.
