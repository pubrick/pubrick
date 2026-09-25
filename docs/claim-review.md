# Advisory claim review

Pubrick can check factual claims in a saved draft against public web search
results. An editor starts a check from the draft screen, or a brand manager can
enable automatic checks for newly generated AI drafts. The result is an
evidence aid, not a certification: search snippets can be incomplete, stale, or
misleading. Open the linked source pages before changing or approving copy.

## Setup

1. Save an AI provider key in **Settings**. Pubrick uses that organization's
   key for claim extraction and evidence comparison.
2. An organization owner or admin saves a Yandex Search API key and folder ID
   in **Settings → Search API**. See the [Yandex setup guide](https://aistudio.yandex.ru/en/docs/search-api/quickstart/).
3. Open a draft, rejected post, or failed post. Save any text changes, then
   select **Check** in the **Claim evidence** card.

For automatic checks, open the brand page and choose **Enable** under
**Automatic claim evidence**. This is off by default and affects only AI drafts
saved after it is enabled. Both workspace keys must already be present when the
draft is saved; without either key, no automatic review is queued. Enabling the
setting itself makes no provider request. Every automatic review may make up to
five billable Yandex searches and billed AI calls on the workspace keys.

Search credentials are encrypted at rest and never returned to the browser.
Neither saving nor removing the key makes a billable search request.

## What a check does

The request is tied to the exact saved article body. A background job asks the
AI provider for up to five factual or time-sensitive claims, searches the web
for each claim, and compares the claim only with the returned result titles and
snippets.
The card shows the claim, an advisory outcome, and links to the result pages.
It does not fetch those pages or alter the draft. An empty or failed search is
never evidence that a claim is true.
The card identifies whether the review was started by an editor or automatically.
Automatic checks use the same bounded queue and the same saved-body and
organization guards as editor-started checks. If the body changes before or
during a check, the worker stops spending on it and records a stale or failed
outcome. Neither path rewrites copy or asserts that a claim was verified.

Editing and saving the article makes earlier results **stale**. A stale review
remains visible for context, and the editor can start a new one for the saved
version. Unsaved text cannot be checked. A check already queued or running for
the same saved version is reused instead of billed twice.

Each run can make up to five Yandex searches and AI model calls on the
organization's keys. Yandex bills search requests separately from model
usage; see [Yandex pricing](https://aistudio.yandex.ru/en/docs/search-api/pricing).
Pubrick reserves at most 100 search requests per organization per UTC day;
requests with an uncertain outcome still count toward that limit.
Pubrick records attempted searches and model usage, including attempts whose
outcome is uncertain after a process failure. Provider outages and missing
keys are shown as failures or unavailable evidence, not as verification.

The search transport's bounds and provider response format are documented in
[Search provider](./search-provider.md).

## Suggested corrections

When a ready review finds a conflicting snippet in an AI-generated draft,
the editor may request a paid replacement suggestion for the exact quoted
claim. Pubrick shows the original wording, suggested replacement, explanation,
and search results used for the suggestion. Search results are leads: open the
linked pages and check them before choosing **Accept**. The model never applies
a correction automatically.

The suggestion belongs to one saved body and one review. A changed draft or a
new review makes it stale. **Accept** replaces only the exact claim in an
unchanged draft and records an AI fragment and accepted-correction receipt;
**Discard** removes the pending suggestion. A claim that occurs more than once
must be edited manually, because an automatic replacement would be ambiguous.
Empty or unavailable search results cannot produce a correction suggestion.
The call uses the organization's AI key and shares the editor's hourly AI
allowance. It can make up to two billable model calls when a structured reply
needs repair; a failed response may still incur provider cost.

Accepted corrections remain in the card's **Accepted corrections** history,
with the original claim, replacement, explanation, saved search-result links,
and the AI fragment version created by Accept. The history is loaded only when
opened and can be paged without losing older receipts. It does not claim that
the linked pages were fetched or independently verified.
