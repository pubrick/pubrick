# Owner-controlled autopilot

Autopilot is an opt-in draft generator for each brand. An organization owner or
admin saves the brand's channels, IANA time zone, earliest local hour, quiet
window, daily run quota (1–5), and daily USD spend threshold. The default is off.
The `autopilot-scan` pg-boss job checks enabled brands every five minutes.

## Dated-topic calendar planning

**Plan approved dated topics automatically** is an independent, default-off
setting. It needs at least one selected channel and does not enable direct
generation. An hourly scan checks approved topics with target dates in the next
14 local days, then creates reviewable 10:00 calendar slots up to the brand's
daily slot limit. A past scheduled instant is skipped. Direct autopilot
generation uses undated topics, so the two paths do not dispatch the same
topic. Calendar slots still check approval and topic revision at their due time;
each generated draft waits for human review.

The secondary **Plan now** action is available after saving the opt-in. An
owner or admin confirms the request; the API queues the same planner with a
60-second per-brand cooldown. It rechecks saved settings when the job runs and
is safe to overlap with the hourly scan. The action does not generate or
publish content immediately. New slots appear in the brand calendar.

## Daily topic ideas

**Suggest topics daily** is a separate, default-off brand setting. It does not
enable draft generation. After 09:00 in the brand's configured IANA time zone,
the worker can queue one suggestion request per local day using the
organization's configured AI key. The request yields up to three ideas, charges
at most one physical suggestion-text model call, and is skipped if there is no key or at least three AI
ideas already awaiting review. A failed daily attempt is not retried at the
provider; an owner can still request suggestions manually from the Topic bank
after the normal 30-minute request cooldown.

Suggested topics remain **Idea**. An editor reviews and approves them before
generation, and chooses dates and channels through the calendar's reviewed bulk
planning form. This setting creates no calendar slots, drafts, or publications.
By default, automatic suggestions skip exact normalized title repeats without
paid embeddings, so paraphrased blocked ideas can still appear for editor review.
An owner or admin can explicitly enable **Filter blocked topic paraphrases**
beneath the daily suggestions setting. The opt-in is copied onto each request
when the scanner queues it: changing the setting later cannot add paid calls to
an existing request. With recent reviewer-blocked topics, the request needs a
Google AI key, even if its suggestion-text provider is OpenRouter. It compares
at most 20 recent blocked titles using at most three separately metered Google
embedding calls in addition to the single suggestion-text call. A missing key,
provider or ledger failure, blocked-set change, or queue redelivery cannot
admit unverified ideas. Each call is recorded before suggestions are saved.
The generation spend threshold below covers generation runs; topic suggestion
text and embedding calls are recorded separately in the organization usage
ledger and are outside that threshold. Embedding prices may be unknown in the
ledger; the recorded call still shows the spend occurred.

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
