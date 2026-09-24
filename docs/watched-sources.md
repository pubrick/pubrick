# Watched sources

Pubrick can collect articles from public RSS, Atom, RDF, and JSON feeds and use
their **titles and summaries** as source material for a draft. It does not read
the full linked article yet. Open the original before relying on a detail that
is absent from the feed summary.

## Use it

1. Open a brand and choose **Watched sources**.
2. Add the feed's name and URL. The first check is queued immediately.
3. Choose **Refresh** for another check, or wait for the background scan. The
   scan runs every 15 minutes and respects each source's check interval (60
   minutes by default; API range 15–1440). Repeated checks for the same source
   are suppressed for approximately five minutes; the UI reports when a new
   check was not queued.
4. In **Recent articles**, open the original or choose **Create draft**. Select
   the channels explicitly; Pubrick starts the existing five-role generation
   run with the title, summary, and source URL. Generation uses the
   organization's stored Gemini or OpenRouter key and consumes its tokens.

Pause prevents future checks. Remove deletes the source and its collected
articles, while any drafts already created from those articles remain.

An editor can also mark an article **Relevant** or **Irrelevant**, or choose
**Save topic**. These are human decisions recorded for the brand. Saving is
idempotent for one article. The topic keeps a snapshot of its title, summary,
and URL, so deleting a source does not erase an idea already saved.

The worker scores up to 20 newly collected articles per hour against the
brand's description, voice, and audience. **Score** queues one article sooner.
Scoring uses the organization's Gemini or OpenRouter key and writes each
physical model call to the usage ledger. The AI returns a 0–100% match, a short
reason, and an urgency label. The badge shows that raw AI score. On a newly
scored article, Pubrick also compares its feed headline and summary with up to
50 previously marked Relevant and 50 marked Irrelevant articles from the same
organization and brand. A strong headline overlap adjusts its **ranking score**
by at most 20 percentage points in either direction. Opposing matches cancel;
unrelated marks have no effect. **Sort by relevance** and AI topic suggestions
use the ranking score. The API returns both `relevanceScore` (the raw AI score)
and `rankScore` with `feedbackDelta` so the adjustment is inspectable. An
editor changing a mark affects future scores only; existing scored articles
are not silently rescored.

This comparison is intentionally lexical. It recognizes sufficiently similar
headlines, not semantic paraphrases, and can miss related articles. The
reference implementation used 768-dimensional news embeddings; Pubrick does
not currently index news vectors. This adjustment makes no additional provider
call and does not train a model. Filter by scoring status in Recent articles.
An unscored or failed article has no numeric score; a
provider error is never shown as 0%. A failed score can be retried manually.
The AI score is advisory and never changes the editor's Relevant/Irrelevant
choice, approves a topic, generates a draft, or publishes content.

## Boundaries

- Sources, articles, and actions are scoped to both organization and brand.
  Repeated polls deduplicate by article URL within a brand.
- A feed is untrusted input. `guarded-fetch` checks public DNS answers and pins
  the connection to a checked IP, including across redirects; it rejects local
  addresses, caps the response at 2 MiB, and times out after 10 seconds. Feed
  URLs with embedded credentials are refused. Feedsmith parses the four feed
  formats, and `html-to-text` turns summaries into plain text before storage.
- A check stores at most 50 articles, 500 characters per title, and 8,000 per
  summary. No article body, image, comment, or linked page is fetched.
- A failed check records a small error code on the source; raw remote error
  bodies are never returned to the browser. Refreshing a paused source is
  refused until it is resumed.

The model sees the feed title and at most the first 4,000 summary characters,
plus the feed publication date when provided; it does not read the full article.
It can make mistakes and does not verify claims. Up to three queue deliveries are attempted
automatically; each model call has a 60-second budget and no SDK transport
retries. A structured-output repair can make one additional call per delivery.
The hourly scan is bounded to 20 articles globally per installation; editors
can request scoring individually. Feedback changes advisory ranking only.

## Dependencies

`feedsmith` was chosen over `rss-parser` because Pubrick needs Atom, RDF, and
JSON Feed as well as RSS. `guarded-fetch` replaces the reference monitor's
hostname regex, which did not cover DNS rebinding or redirect targets.
`html-to-text` replaces tag-stripping regular expressions so stored summaries
remain readable.
