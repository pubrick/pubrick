# Import a public source as source material

On **New post**, select a brand. Under **Source**, paste a public HTTP(S) article or
newsletter web archive URL and choose **Fetch source**. Pubrick shows an extracted
text preview. Choose **Use this text** to
place it in the editable source field, select the destination channels,
then choose **Generate**. The existing generation run stores that text by value
and records the URL as attribution. The worker never revisits the URL. Fetching
the preview makes no AI call; generation uses the organization's configured key.

The API's authenticated `POST /api/source-extraction` accepts `{ "url": "…", "brandId": "…" }`
and returns `{ "title": "…", "material": "…", "truncated": false }`. It does
not save content. Authors and editors must supply a brand they can access;
existing workspace roles may still send only `url` for compatibility.
[`guarded-fetch`](https://github.com/vercel-labs/guarded-fetch)
protects against requests to private addresses and unsafe redirects, with a
10-second timeout and 2 MiB response cap. Mozilla
[`Readability`](https://github.com/mozilla/readability) extracts article text
from the returned HTML; scripts and page resources are not loaded. Pubrick
returns only text, capped at 8,000 characters, and tells the user if it was
shortened.

Pages that require login, client-side rendering, or contain no readable article
text need a manual paste. A private email inbox and an email message URL are not
connected; for newsletters, use a public web archive page or paste the text.

## Import available YouTube captions

Paste a public YouTube watch, Shorts, live, embed, or `youtu.be` video URL and
choose **Fetch source**. Pubrick uses the MIT-licensed
[`youtube-transcript`](https://github.com/Kakulukian/youtube-transcript) package
to fetch a caption track exposed by YouTube. Its transport accepts only HTTPS
YouTube endpoints, refuses redirects, limits each response to 2 MiB, and applies
a 10-second request timeout. The preview contains the caption text, not the
video audio or an AI transcription. Choose **Use this text** before generating;
the accepted text is saved by value, with the video URL as attribution. No AI
call is made while fetching the preview.

YouTube's caption endpoint is unofficial and may change or deny access from a
self-hosted server. If captions are disabled, absent, blocked, or inaccessible,
upload a transcript file or paste the text. Pubrick never fabricates a transcript.

## Import a transcript file

On the same **New post → Source** screen, choose a UTF-8 `.srt`, `.vtt`, or
`.txt` transcript (up to 2 MiB). Pubrick reads it in the browser. For caption
files, it uses [`media-captions`](https://github.com/vidstack/captions)
(MIT licensed) to extract cue text without timestamps, cue numbers, or styling.
Unlike a small custom parser, the library handles the WebVTT cue format and
SubRip timing rules. The file is not uploaded or sent to an API. A preview
shows the first 8,000 characters and tells you if it was shortened. Choose
**Use this text** to place it in the editable source field before generating.
You may enter the video URL above as attribution; generation still uses the
accepted text, not the remote URL. The 2 MiB limit applies before reading and
the 8,000-character limit applies to material sent to the run.

A URL is never treated as proof that a claim is true or current; review the
draft before publishing.
