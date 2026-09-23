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

The reference Content Factory also scored relevance, stored feedback, and
turned news into a topics bank. Those are separate upcoming slices; this feed
is chronological and makes no relevance claim.

## Dependencies

`feedsmith` was chosen over `rss-parser` because Pubrick needs Atom, RDF, and
JSON Feed as well as RSS. `guarded-fetch` replaces the reference monitor's
hostname regex, which did not cover DNS rebinding or redirect targets.
`html-to-text` replaces tag-stripping regular expressions so stored summaries
remain readable.
