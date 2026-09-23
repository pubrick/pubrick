# Import a public article as source material

On **New post → Source**, paste a public HTTP(S) article URL and choose **Fetch
article**. Pubrick shows an extracted text preview. Choose **Use this text** to
place it in the editable source field, select the brand and destination channels,
then choose **Generate**. The existing generation run stores that text by value
and records the URL as attribution. The worker never revisits the URL. Fetching
the preview makes no AI call; generation uses the organization's configured key.

The API's authenticated `POST /api/source-extraction` accepts `{ "url": "…" }`
and returns `{ "title": "…", "material": "…", "truncated": false }`. It does
not save content. [`guarded-fetch`](https://github.com/vercel-labs/guarded-fetch)
protects against requests to private addresses and unsafe redirects, with a
10-second timeout and 2 MiB response cap. Mozilla
[`Readability`](https://github.com/mozilla/readability) extracts article text
from the returned HTML; scripts and page resources are not loaded. Pubrick
returns only text, capped at 8,000 characters, and tells the user if it was
shortened.

Pages that require login, client-side rendering, or contain no readable article
text need a manual paste. This workflow does not extract YouTube transcripts or
newsletter inbox contents. The URL is never treated as proof that a claim is
true or current; review the draft before publishing.
