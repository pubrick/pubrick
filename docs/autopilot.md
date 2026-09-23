# Owner-controlled autopilot

Autopilot is an opt-in draft generator for each brand. An organization owner or
admin saves the brand's channels, IANA time zone, earliest local hour, quiet
window, daily run quota (1–5), and daily USD spend threshold. The default is off.
The `autopilot-scan` pg-boss job checks enabled brands every five minutes.

Only an editor-approved topic can be dispatched. The worker takes the same
organization admission lock as manual and calendar generation, checks the
brand's settings again, and writes the run, immutable topic-to-run dispatch
record, and pg-boss job in one transaction. A topic is dispatched at most once.
The resulting content remains a draft; normal review and approval gates still
apply. Autopilot never calls a publisher.

The spend threshold stops **new** runs when priced usage linked to this brand's
generation runs on the local day reaches the threshold. Image-generation calls
without a run ID are not included because the ledger cannot attribute them to
a brand. It is not a hard ceiling on a run already in progress. New runs are
also paused if the ledger contains an unpriced call or a
run reports calls that could not be recorded. At most one automatic run per
brand is live at a time; the existing organization-wide concurrent-run limit
also applies. Usage continues through the normal Google BYOK ledger and run
receipt. The settings screen states these limits and links to each automatic
run's outcome.

The old Content Factory additionally planned a calendar, sent digests and
could auto-publish. Those paths have not been enabled here. Pubrick's promise
is that publication needs human review and explicit approval.
