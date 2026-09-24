# Owner-controlled autopilot

Autopilot is an opt-in draft generator for each brand. An organization owner or
admin saves the brand's channels, IANA time zone, earliest local hour, quiet
window, daily run quota (1–5), and daily USD spend threshold. The default is off.
The `autopilot-scan` pg-boss job checks enabled brands every five minutes.

## Daily topic ideas

**Suggest topics daily** is a separate, default-off brand setting. It does not
enable draft generation. After 09:00 in the brand's configured IANA time zone,
the worker can queue one suggestion request per local day using the
organization's configured AI key. The request yields up to three ideas, charges
at most one physical model call, and is skipped if there is no key or at least three AI
ideas already awaiting review. A failed daily attempt is not retried at the
provider; an owner can still request suggestions manually from the Topic bank
after the normal 30-minute request cooldown.

Suggested topics remain **Idea**. An editor reviews and approves them before
generation, and chooses dates and channels through the calendar's reviewed bulk
planning form. This setting creates no calendar slots, drafts, or publications.
The generation spend threshold below covers generation runs; topic suggestion
calls are recorded separately in the organization usage ledger.

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

The daily digest is a separate, per-brand Telegram notification configured in
Settings → Notifications. Its local hour and timezone do not alter autopilot's
generation window or budget. The digest reports generation-run outcomes and
spend; it does not create content or publish anything. Publication still needs
human review and explicit approval.
