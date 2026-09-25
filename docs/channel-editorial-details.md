# Channel hashtags and editorial calls to action

The reference Content Factory generated `hashtags` and `cta` separately. It
stored both on an adaptation and its saved versions. Its publishing path
appended hashtags to the adaptation body before delivery. The CTA field was
shown to editors but was never appended to a published post.

Pubrick keeps `adaptations.body` as the canonical text for one channel. A
structured hashtag edit replaces the managed final tag block in that body in
the same transaction that saves `adaptations.hashtags`. A generated adaptation
is composed before its body and AI version are saved. A call to action is an
editorial suggestion only: it is stored and versioned, but never sent unless
an editor writes it into the body. The editor states this next to the field.

| Consumer | Text used |
| --- | --- |
| Approval and media-caption length guards | Canonical `adaptations.body`, or the master body when there is no override |
| Channel preview and manual copy | The same body, including unsaved tag changes in local preview |
| Platform send and retry | The same saved body; retry never recomposes tags |
| Saved full versions and Restore | Canonical body plus snapshotted `hashtags` and `cta` metadata |
| VC.ru export | The saved canonical channel body |
| Public RSS | The master content body snapshotted at feed inclusion; it is a separate syndication choice and does not inherit channel tags |

The migration adds nullable CTA and empty tag arrays to existing rows without
touching their bodies or publication receipts. Published adaptations remain
locked, so existing platform posts cannot be silently rewritten. The tag
composer is deterministic and idempotent for its own suffix. It removes only a
trailing tag-only block separated by a blank line whose tags belong to the
previous managed tag set; an inline hashtag typed into a sentence remains
editorial text.
