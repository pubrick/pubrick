# Advisory claim review

Pubrick can check factual claims in a saved draft against public web search
results. The editor starts each check from the draft screen. The result is an
evidence aid, not a certification: search snippets can be incomplete, stale, or
misleading. Open the linked source pages before changing or approving copy.

## Setup

1. Save an AI provider key in **Settings**. Pubrick uses that organization's
   key for claim extraction and evidence comparison.
2. An organization owner or admin saves a Yandex Search API key and folder ID
   in **Settings → Search API**. See the [Yandex setup guide](https://aistudio.yandex.ru/en/docs/search-api/quickstart/).
3. Open a draft, rejected post, or failed post. Save any text changes, then
   select **Check** in the **Claim evidence** card.

Search credentials are encrypted at rest and never returned to the browser.
Neither saving nor removing the key makes a billable search request.

## What a check does

The request is tied to the exact saved article body. A background job asks the
AI provider for a small set of time-sensitive factual claims, searches the web
for each claim, and compares the claim only with the returned source snippets.
The card shows the claim, an advisory outcome, and links to the result pages.
It does not fetch those pages or alter the draft. An empty or failed search is
never evidence that a claim is true.

Editing and saving the article makes earlier results **stale**. A stale review
remains visible for context, and the editor can start a new one for the saved
version. Unsaved text cannot be checked. A check already queued or running for
the same saved version is reused instead of billed twice.

Each run can make up to five Yandex searches and AI model calls on the
organization's keys. Yandex bills search requests separately from model
usage; see [Yandex pricing](https://aistudio.yandex.ru/en/docs/search-api/pricing).
Pubrick records attempted searches and model usage, including attempts whose
outcome is uncertain after a process failure. Provider outages and missing
keys are shown as failures or unavailable evidence, not as verification.

The search transport's bounds and provider response format are documented in
[Search provider](./search-provider.md).
