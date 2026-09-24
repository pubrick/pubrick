# Images inside articles

An editor can place up to five images after paragraphs in any draft. This also
supports manually written articles without a generation run. Images come from
the brand's media library, including images generated through the
existing metered Gemini image action. Images require alternative text and can
have a caption. Placement uses the zero-based index of a nonempty paragraph;
if the text changes, review image positions before publishing.

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
The API checks membership in the active organization, access to the brand,
image kind, paragraph bounds, unique positions, and the editing state. The
database ties each slot to an item and media asset of the same organization
and brand. A media asset in a slot cannot be deleted until detached.

Public RSS remains opt-in. When a member adds a published item to its brand
feed, Pubrick snapshots the text and image placement together. The feed and
public article render escaped HTML with images supplied through a URL scoped
to the feed token and the specific entry. The original authenticated media URL
is never embedded in the feed. Removing the entry or disabling the feed
revokes those image URLs. The snapshot keeps its media assets until removed,
even if the editable slot is later detached.

The current text publishers do not transmit these inline images. VC.ru's
manual copy flow copies plain text; an HTML or asset bundle export for that
platform remains separate work. Generated image prompts and per-slot automatic
regeneration are not yet part of the draft pipeline.
