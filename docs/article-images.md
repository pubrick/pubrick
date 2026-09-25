# Images inside articles

An editor can place up to five images after paragraphs in any draft. This also
supports manually written articles without a generation run. Images come from
the brand's media library, including images generated through the
existing metered Gemini image action. Images require alternative text and can
have a caption. Placement uses the zero-based index of a nonempty paragraph;
if the text changes, review image positions before publishing.

For an `expert_article`, `comparison`, `case_study`, or `educational` direct
generation run, the editor can opt in to automatic illustrations. Calendar
slots can use `expert_article`, `comparison`, and `educational`; formats that
need pasted source material cannot be scheduled from a brief alone. The worker
creates up to two images for a draft with at least two nonempty paragraphs.
Each physical Gemini image call is metered against the organization's shared
12-calls-per-hour image limit; the run reserves the maximum of two calls before
it is queued.
Generated slots are saved with the draft as placements, never as inline markup.
They require an editor to inspect the image, placement, and alternative text,
then explicitly acknowledge each generated slot and save before approval.
The API enforces that review gate, including for non-UI clients. Generated
images may be replaced or varied through the existing media editor; the
replacement still needs the editor's own alternative text.

Image slots are separate records. `content_items.body` and channel adaptations
remain plain text, so a Telegram, VK, MAX, Bluesky, or Mastodon post never
receives markup or an internal image marker. The existing cover attachment is
also separate. Editors can change image slots while an item is a draft,
rejected, or failed. A published item keeps the images it had at approval.

`GET /api/content/:id/images` returns `{ "images": [...], "revision": 0 }`,
with slots in paragraph order. `PUT` to the same endpoint replaces the set
atomically with
`{ "expectedRevision": 0, "images": [{ "mediaId": "…", "afterParagraph": 0, "alt": "…", "caption": "…" }] }`.
The response carries the new revision. A stale revision returns 409 so a
second editor cannot silently overwrite an earlier save.
Generated slots expose `needsReview: true` until the editor sends
`reviewGeneratedImages: true` in a successful replacement request. An ordinary
save preserves the review requirement for a retained generated media asset,
even if its text or placement changed.
The API checks membership in the active organization, access to the brand,
image kind, paragraph bounds, unique positions, and the editing state. The
database ties each slot to an item and media asset of the same organization
and brand. A media asset in a slot cannot be deleted until detached.

Saved slots also support a local, unmetered crop. The editor frames the image
with `react-easy-crop` (MIT); Pubrick sends the pixel rectangle to
`POST /api/content/:id/images/:slotId/crop` with `expectedRevision` and
`sourceMediaId`. The API checks the active organization, item and brand,
editing state, current slot revision, original image identity, and crop bounds.
It uses Sharp to write a new normalized JPEG and updates the slot in the same
database transaction. A failed request removes the new file. Cancel makes no
request. The original stays in the brand media library; the cropped result
keeps the slot's placement, alternative text, and caption, increments the image
revision, and requires explicit image review before approval. The editor can
revise the alternative text if the crop changes what it describes. Cropping
an approved or published item is refused. No Gemini call or usage charge occurs.
The crop frame supports arrow-key movement and a labelled zoom slider. A
missing source image is reported in the editor and cannot be saved.

For a saved slot, `POST /api/content/:id/images/:slotId/regenerate` with
`{ "expectedRevision": 0, "expectedBody": "…" }` creates one metered Gemini
variation from the current image and saved article context. The server checks
the slot, revision, and saved body before the model call and again afterward.
It replaces only that slot and requires the editor to review the new image,
placement, and description before approval.
If another editor changes the draft while the call runs, the endpoint returns
409 and leaves the newly generated image in the brand's media library.

Public RSS remains opt-in. When a member adds a published item to its brand
feed, Pubrick snapshots the text and image placement together. The feed and
public article render escaped HTML with images supplied through a URL scoped
to the feed token and the specific entry. The original authenticated media URL
is never embedded in the feed. Removing the entry or disabling the feed
revokes those image URLs. The snapshot keeps its media assets until removed,
even if the editable slot is later detached.

The current text publishers do not transmit these inline images. VC.ru's
manual copy flow copies plain text; the downloadable article package includes
the saved inline images. Automatic generation is opt-in for direct article
runs and scheduled article slots.
