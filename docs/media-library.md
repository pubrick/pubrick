# Media library

Each brand has a reusable image library. A signed-in organization member can
upload JPEG, PNG, or WebP files up to 10 MB from **Brand → Media library**, then
choose a cover on an editable post. An image can be removed from the library
after it is detached from every post.

The API decodes images with `sharp` (a maintained libvips binding), applies EXIF
orientation, resizes within 2400 × 2400 pixels, and writes a new JPEG without
source metadata. This keeps uploaded files from being served as executable
formats and strips camera/location metadata. Decode is limited to 40 million
input pixels. Files have server-generated UUID names; the database records
organization, brand, dimensions, size, and the original display name. The
authenticated file endpoint checks organization ownership before reading bytes.

`MEDIA_STORAGE_DIR` points to a directory shared by the API and worker. Docker
Compose mounts the named `media` volume into both services; `init.sh` sets it to
`./.data/media`. Back up this directory **together with Postgres**. Copying only
the database preserves post references but loses their image bytes. Uploaded
images remain local to the self-hosted instance.

Deleting a brand removes its asset rows and then deletes their files. If the
process stops between those two steps, an unreferenced file can remain on disk;
the brand deletion still succeeds and the server logs any removal failure.

## Publishing boundary

Telegram and VK accept a single JPEG cover. Telegram uses one `sendPhoto`
request with the reviewed text as its caption (maximum 1024 characters).
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

## Generate and revise images

With a Google BYOK key saved in organization settings, the library offers an
explicit **Generate image** action. Describe the image and click once; Pubrick
calls Google's stable `gemini-3.1-flash-image` model for a 1K image. **Try
variation** on an individual image sends that brand's JPEG alongside a new
instruction. Each result is a new, normalized asset; the source remains intact.
The result is not attached to any post. Review it and choose **Use** on an
editable Telegram or VK post before approval. No background generation is triggered
by typing, opening the library, or approving a post.

Every dispatched image request records a BYOK row in `usage_ledger`, including
failed and uncertain outcomes. Where Gemini returns modality token counts,
Pubrick estimates the standard tier cost using the published input, image
output, text output and thinking rates. Missing details remain `unknown` rather
than claiming a zero cost. The organization limit is 12 image calls per hour;
one click makes one provider request with no retry. Provider error bodies and
keys never reach the browser. The image model and rates should be reviewed as
Google changes its [model](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-image)
and [pricing](https://ai.google.dev/gemini-api/docs/pricing) documentation.

MAX image delivery remains future work. The media library never implies that
channel will receive a cover.
