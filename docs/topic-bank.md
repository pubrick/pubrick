# Topic bank

Topics collect editorial ideas before generation. Open a brand and choose
**Topic bank**. Add an idea directly, or open **Watched sources** and save a recent
article. A saved article contributes its feed title, summary, and link only;
Pubrick does not read the linked page. Saving the same article twice returns
the existing topic.

**Suggest topics with AI** requests up to three brand-specific ideas. The worker
uses the brand profile, up to 30 approved bank entries, up to 10 scored news
articles, up to 10 unfilled editorial reservations in the next 14 brand-local
days, and up to 10 active memorable dates occurring in the next 28 days while
their configured lead windows are open. The brand's validated IANA timezone
determines today; a missing or invalid stored timezone falls back to UTC.
Only structured reservation metadata is sent to the model; freeform reservation
notes are excluded. These calendar signals are suggestions, not due jobs.
Explicit Irrelevant feedback excludes an article; Relevant
feedback can admit it even if its score is low. Otherwise, a bounded headline
feedback adjustment influences which scored articles reach the context list.
Feed summaries are untrusted source material; Pubrick does not
read linked pages or treat a score as a fact check. Generated ideas appear in
the bank as **Idea · AI suggestion**. A request is limited to one every 30
minutes per brand (unless its key is missing or unreadable), runs through a
bounded per-organization queue, and records every physical model call in the
usage ledger using the organization's AI key. Repeated titles are skipped.
The request status shows queued, running, completed, or failed; zero new ideas
means the results were repeats or reviewer-blocked near matches, not that the
model failed.

Each AI idea may retain one validated source: scored news, an editorial opening,
a memorable date, or none. The model may return only an ID included in that
request's brand-scoped context; foreign, invented, or multiple references are
discarded. Pubrick saves the source kind, ID, server-built label, and calendar
date as a snapshot so the chip remains meaningful if the source is later
edited or deleted. A source chip indicates inspiration, not verification.
Calendar-inspired ideas remain unapproved, with no target date; they never fill
the reservation or create a slot, run, draft, or publication. Calendar context
adds no model call. Each attempt makes at most one physical suggestion-text
call; an automatic request never retries that call, while a manual request can
be retried after a transient provider failure. Invalid structured output fails
without a paid repair call.

For a **manual** request, and for an **automatic** request whose owner or admin
enabled the paid semantic filter before the scanner queued it, Pubrick also
compares proposed titles with every
reviewer-blocked topic from the same brand in the last 90 days, including
manually created topics. It uses Google's `gemini-embedding-001` with 768
dimensions and a cosine threshold of 0.88. This needs a Google BYOK key even
when the text suggestion uses OpenRouter. At most 20 recent blocked titles
and three physical embedding calls are admitted per request; the calls are
recorded separately in the usage ledger. A request with blocked titles does not
buy another provider call on queue redelivery. More than 20 recent blocks, an
embedding failure, an unavailable ledger, or a changed blocked set fails the
request without adding ideas. Automatic requests without the opt-in do not
buy embeddings and still apply only the exact-title check below. The opt-in is
snapshotted on the request; later setting changes cannot retroactively add
paid calls. A daily request still buys at most one suggestion-text call, plus
up to three embedding calls when recent blocks exist. These calls are outside
the generation spend cap.

An owner or admin can separately enable **Suggest topics daily** in the brand's
Autopilot settings. After 09:00 in the brand's time zone, it queues at most one
suggestion request per local day, using at most one physical suggestion-text AI provider call. It
skips brands without an AI provider key or with at least three AI ideas still waiting
for review. Daily suggestions follow the same Idea and approval flow as manual
suggestions; they do not plan a calendar slot, start a draft, or publish.

An editor can edit the title and description, approve the idea, archive it, or
remove it. Only an approved topic can start a generation run. Select the
channels explicitly, then **Generate**. Pubrick submits the approved text to
the existing generation engine and opens its run receipt. This uses the
organization's configured AI key, consumes tokens, and still requires human
review of the draft before publication. An approved topic can be reused for
multiple runs.
Editing an approved topic returns it to **Idea**, so its new text needs a fresh
approval.

The topic list also shows observed results for its latest 200 topics: linked
generation runs, surviving drafts, and distinct drafts with at least one
published delivery. A draft sent to several channels is counted once in the
published-draft figure. Available VK observations show the number of published
VK posts checked, the count of posts with each reported counter, and the latest
check time. A missing counter means **unknown**, not zero; partial coverage
does not represent every publication. This is a read of saved receipts, not a
new VK request or an AI rating of the topic. Results do not influence topic
suggestions or automatically start another run.

The attribution follows surviving links from topic to run, draft, and live
publication adaptation. Deleting a topic removes it from this view; deleting a
draft or channel may leave historical receipts that can no longer be attributed
to that topic. These counts therefore describe observable records, not a
complete lifetime performance report.

Use **Block** in a topic's More menu to archive it with a required reason and
time. A blocked topic cannot be edited, approved, deleted, or used for a new
run. An unstarted calendar slot linked to the old topic revision fails as
`topic_changed` before it can call the AI provider. Existing drafts and runs
are unchanged. **Unblock** returns the topic to **Idea** and requires a fresh
approval; it clears the block reason and time.

AI suggestion completion checks every existing title in that brand, including
blocked topics, using Unicode NFKC normalization, English lowercase, and
collapsed whitespace. This skips **exact normalized title repeats**. Similar
or paraphrased titles may still be suggested, especially on the automatic
path. The block action and suggestion completion share a brand transaction lock
so a completed suggestion cannot slip between the block and this check.
Manual suggestion completion rechecks the blocked set under that lock after
its embedding calls. Blocking itself makes no paid AI call.

All topic and article actions are scoped to organization and brand. Deleting a
source removes its collected articles, but leaves saved topics and existing
drafts. Deleting a topic leaves earlier generation runs and drafts. The article
feedback controls record human judgements. Feedback influences which scored
articles may be used for suggestions; it never trains a model or automatically
approves a topic. Suggestions never start generation or publish.
