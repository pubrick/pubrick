# Media library

Each brand has a reusable media library. A signed-in organization member can
upload JPEG, PNG, or WebP files up to 10 MB from **Brand → Media library**, then
choose a cover on an editable post. The library also accepts an MP4 video up
to 20 MB for a Telegram post. A post has one attachment: choosing a video
replaces its cover, and choosing a cover replaces its video. The editor and
external client review offer a click-to-play video preview before approval.
An asset can be removed after it is detached from every post.

The API decodes images with `sharp` (a maintained libvips binding), applies EXIF
orientation, resizes within 2400 × 2400 pixels, and writes a new JPEG without
source metadata. This keeps uploaded files from being served as executable
formats and strips camera/location metadata. Decode is limited to 40 million
input pixels. Files have server-generated UUID names; the database records
organization, brand, kind, dimensions (for images), size, and the original display name. The
authenticated file endpoint checks organization ownership before reading bytes.

Video upload uses the maintained `file-type` library to detect the MP4 signature
and checks top-level MP4 box lengths for a complete `ftyp`, `mdat` and `moov`.
It rejects a mismatched declared MIME type, truncated files and files outside
1 KB–20 MB, and stores the original bytes with a server-generated `.mp4` name.
It does **not** decode, transcode, inspect codecs or prove that the whole file
will play in every Telegram client. Test the clip in the review preview before
approving. A Telegram codec/container rejection becomes a failed delivery;
Pubrick does not claim video generation. The private file endpoint supports
byte ranges for playback. External review ranges recheck the live, expiring
capability on every request, enforce stored size and return `no-store` and
`no-referrer` headers. Replacing or removing video invalidates the review snapshot.
The current library has no caption-file sidecar for video audio; provide an
accessible text description in the post body when sharing a clip.

`MEDIA_STORAGE_DIR` points to a directory shared by the API and worker. Docker
Compose mounts the named `media` volume into both services; `init.sh` sets it to
`./.data/media`. Back up this directory **together with Postgres**. Copying only
the database preserves post references but loses their media bytes. Uploaded
media remains local to the self-hosted instance.

Deleting a brand removes its asset rows and then deletes their files. If the
process stops between those two steps, an unreferenced file can remain on disk;
the brand deletion still succeeds and the server logs any removal failure.

## Publishing boundary

Telegram, VK, MAX, and Bluesky accept a single JPEG cover. Telegram uses one `sendPhoto`
request with the reviewed text as its caption (maximum 1024 characters).
Telegram video uses one `sendVideo` request with the reviewed MP4 and a caption
of at most 1024 characters. This milestone supports **Telegram video only**;
attaching a video to a post with VK, MAX, Bluesky, Mastodon or VC.ru targets is
refused before approval. The worker also checks the organization, brand, media
kind and stored byte length before sending. An uncertain `sendVideo` result is
terminal until reconciled, preventing an automatic duplicate. There is no
provider call when a video is uploaded or previewed.
VK uses the official `photos.getWallUploadServer` → multipart upload →
`photos.saveWallPhoto` → `wall.post` path and attaches the saved community photo
to the reviewed text ([VK photo methods](https://github.com/VKCOM/vk-api-schema/blob/master/photos/methods.json),
[wall.post](https://github.com/VKCOM/vk-api-schema/blob/master/wall/methods.json)).
The VK connection test requires a user token with `wall`
permission and administration of the selected community. Sending a cover also
checks the `photos` permission before requesting an upload URL, so existing
text-only channels can continue to use a wall-only token.
VK's own API schema lists user tokens for these photo methods; community tokens
cannot be used for this path.

The attach and approval paths refuse unsupported channel mixes. The Telegram
caption limit applies only to Telegram adaptations, including a mixed Telegram
and VK post. The worker refuses an unsupported channel or missing/mismatched
image before a send and records an actionable failed delivery. VK photo
preparation can be retried because no wall post has started. An uncertain
`wall.post` or Telegram `sendPhoto` is never retried into a possible duplicate.
VK upload URLs must use HTTPS on a `vk.com` host and cannot redirect. The
temporary upload URL and its capability query are never logged.
MAX uses `POST /uploads?type=image`, sends the JPEG in a multipart `data` field
to the documented `iu.oneme.ru` image host, and sends one `POST /messages` with
the resulting image token and reviewed text. Its bot token is sent only to the
MAX API, never to the upload URL. Upload URLs must use HTTPS and cannot redirect;
their capability query and image token are never logged. Upload preparation can
be retried because no message was sent. An uncertain final message outcome is
terminal; MAX's explicit `attachment.not.ready` refusal is safe to retry.
See the [MAX upload method](https://dev.max.ru/docs-api/methods/POST/uploads)
and [image message flow](https://dev.max.ru/docs-api/use-cases/sending-messages/media).
Bluesky uploads the JPEG as a blob before creating one `app.bsky.feed.post`
record with an image embed. Its 2 MB image limit is checked before the provider
call. The image upload can be retried; an uncertain record creation remains
terminal to avoid a duplicate. See Bluesky's
[image post guide](https://docs.bsky.app/docs/tutorials/creating-a-post#images-embeds).

## Generate and revise images

With a Google BYOK key saved in organization settings, the library offers an
explicit **Generate image** action. Describe the image and click once; Pubrick
calls Google's stable `gemini-3.1-flash-image` model for a 1K image. **Try
variation** on an individual image sends that brand's JPEG alongside a new
instruction. Each result is a new, normalized asset; the source remains intact.
The result is not attached to any post. Review it and choose **Use** on an
editable Telegram, VK, MAX, or Bluesky post before approval. No background generation is triggered
by typing, opening the library, or approving a post.

The compose screen also offers an unchecked **Generate a cover image** option
for a generation run. It requires a saved Google key and checks the image-call
budget at admission; the selected channels must all support covers (Telegram,
VK, MAX, or Bluesky). After the text and channel adaptations finish, the worker
makes one `gemini-3.1-flash-image` request per cover step attempt using the draft
subject. It normalizes the returned image into the brand library and attaches
it to the newly created draft in the run's fenced terminal transaction. The
draft does not exist until that transaction, so the image cannot overwrite a
cover a person selected in the editor. The editor displays the cover for review;
approval and publication still require the ordinary human gate. If the key is
removed, the budget fills, the provider cannot return a usable image, or the
image cannot be saved, the text draft still succeeds and the run receipt reports
that the cover was unavailable. A dispatched request is logged in
`usage_ledger` even when its outcome or exact cost is unknown. **Try again** on
a run carries its cover choice forward and may make a new billed call. A worker
interruption before the cover checkpoint is saved can also repeat the billed
request.

Every dispatched image request records a BYOK row in `usage_ledger`, including
failed and uncertain outcomes. Where Gemini returns modality token counts,
Pubrick estimates the standard tier cost using the published input, image
output, text output and thinking rates. Missing details remain `unknown` rather
than claiming a zero cost. Pubrick checks a shared nominal limit of 12 image
calls per organization per hour, including cover calls. Concurrent manual and
background requests can exceed that limit because dispatches do not reserve a
slot atomically; the limit is best effort until those paths share a durable
reservation. Each cover step attempt makes at most one provider request, and one
manual click makes one request; neither retries the provider within that
attempt. Provider error bodies and keys never reach the browser. The image
model and rates should be reviewed as
Google changes its [model](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image)
and [pricing](https://ai.google.dev/gemini-api/docs/pricing) documentation.
