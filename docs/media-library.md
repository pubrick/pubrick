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

Telegram is the first image-capable publisher. A covered post uses one
`sendPhoto` request with a JPEG multipart file and the reviewed text as its
caption. Telegram limits captions to 1024 characters. The attach and approval
paths refuse unsupported channel mixes or overlong captions; the worker also
refuses an unsupported channel or missing/mismatched image before a send and
records an actionable failed delivery. Provider responses keep the same
permanent/transient/unknown-outcome classification as text publishing, so an
uncertain `sendPhoto` is never retried into a possible duplicate.

Image generation, per-image regeneration, and VK/MAX image delivery remain
future work. The media library never implies those channels will receive a
cover.
