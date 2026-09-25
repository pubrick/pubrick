# Topic bank

Topics collect editorial ideas before generation. Open a brand and choose
**Topic bank**. Add an idea directly, or open **Watched sources** and save a recent
article. A saved article contributes its feed title, summary, and link only;
Pubrick does not read the linked page. Saving the same article twice returns
the existing topic.

**Suggest topics with AI** requests up to three brand-specific ideas. The worker
uses the brand profile, up to 30 approved bank entries, and up to 10 scored news
articles as context. Explicit Irrelevant feedback excludes an article; Relevant
feedback can admit it even if its score is low. Otherwise, a bounded headline
feedback adjustment influences which scored articles reach the context list.
Feed summaries are untrusted source material; Pubrick does not
read linked pages or treat a score as a fact check. Generated ideas appear in
the bank as **Idea · AI suggestion**. A request is limited to one every 30
minutes per brand (unless its key is missing or unreadable), runs through a
bounded per-organization queue, and records every physical model call in the
usage ledger using the organization's AI key. Repeated titles are skipped.
The request status shows queued, running, completed, or failed; zero new ideas
means the results were duplicates, not that the model failed.

An owner or admin can separately enable **Suggest topics daily** in the brand's
Autopilot settings. After 09:00 in the brand's time zone, it queues at most one
suggestion request per local day, using at most one physical AI provider call. It
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

All topic and article actions are scoped to organization and brand. Deleting a
source removes its collected articles, but leaves saved topics and existing
drafts. Deleting a topic leaves earlier generation runs and drafts. The article
feedback controls record human judgements. Feedback influences which scored
articles may be used for suggestions; it never trains a model or automatically
approves a topic. Suggestions never start generation or publish.
