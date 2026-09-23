# Topic bank

Topics collect editorial ideas before generation. Open a brand and choose
**Topic bank**. Add an idea directly, or open **Watched sources** and save a recent
article. A saved article contributes its feed title, summary, and link only;
Pubrick does not read the linked page. Saving the same article twice returns
the existing topic.

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
feedback controls record human judgements; Pubrick does not currently train or
rank suggestions from those signals.
