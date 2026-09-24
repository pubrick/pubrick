# Brand links and UTM attribution

Pubrick can tag links to a brand's homepage in newly generated channel drafts. Configure the brand under **Brand links** on its page. Leave the website empty to disable the rule. A saved rule belongs to one brand in one organization; no other brand inherits it.

## What changes

- The master draft stays as the model wrote it. Each channel adaptation is checked after its model step and before it is saved.
- A bare HTTP(S) link to the configured homepage gets `utm_source`, `utm_medium`, and `utm_campaign`. Markdown anchor text is unchanged. Raw URLs remain raw URLs.
- A link to a specific page, a subdomain, an external source, or another site stays as written. A homepage URL with its own query or fragment also stays as written.
- Manual edits, AI refinements, and publishing never run the rule again. The draft editor shows the website whose rule was applied when that draft was created. Review every channel draft before approval; Pubrick does not publish generated content automatically.
- If tags would exceed a channel's text limit, the original valid adaptation is kept. No partly tagged or uneditable draft is saved.

The campaign template defaults to `cf_{content_type}_{YYYY_MM}`. `{YYYY_MM}` comes from the generation run's creation date in UTC; `{content_type}` is the run's editorial format (`social_post` for runs created before format selection). Each platform has a default source and medium in `packages/shared/src/link-policy-defaults.ts`, and a brand can override either pair. Query parameters are built with the standard `URLSearchParams` API in a stable order. Existing tags are never overwritten.

## Why this differs from the legacy sanitizer

The old Content Factory replaced every external URL with the brand homepage. That can erase a source citation or redirect a reader away from the referenced material. Pubrick preserves these links and limits automatic changes to the brand's own bare homepage. This also means the old `brand_assets` allowlist is unnecessary for automatic replacement and is not exposed as a setting. The legacy link-replacement behavior is intentionally not migrated.

`linkify-it` (MIT) locates URL spans in Markdown and plain text. It was chosen over a handwritten URL regular expression because URL boundaries, punctuation, and Unicode are easy to get wrong. `tldts` was considered for registrable-domain matching, then omitted: this policy only changes an exact homepage host and does not need public-suffix inference. Native `URL` and `URLSearchParams` handle parsing and query encoding.

## Operational notes

The rule is stored in `brands.link_policy` and checked by the brand DTO. The generated draft records `content_items.link_policy_website` so the editor can identify the policy used even if brand settings change later. Earlier drafts have a null receipt. Configuration changes affect new drafts and do not rewrite existing content. A run resumed after a brand settings change reads the current rule; the campaign month remains pinned to the run creation time. A future run-level configuration snapshot would be needed to freeze every setting across such a resume.
