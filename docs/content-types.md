# Editorial formats in generation

Pubrick can generate a social post, news digest, product update, expert article, or how-to guide from a brief, pasted material, or both. Choose **Generate as** on the New post screen. The selected format is saved in the run input and displayed on its receipt; retry uses the same format. Older runs with no format field remain social posts.

This ports the legacy Content Factory's `news_digest`, `product_update`, `expert_article`, and `educational` intents into Pubrick's existing researcher → writer → editor → claims-to-verify → per-channel adapter pipeline. The legacy `product_update` uses the news digest pipeline; Pubrick gives it a distinct concise release policy within the same five-step pipeline. The format changes trusted role guidance, not the pipeline, queue, model selection, or billing path. Every physical language-model call continues through the same metered step runner. Runs remain scoped to the active organization and brand by the existing repository.

| Format | Editorial goal | Master draft constraint |
| --- | --- | --- |
| Social post | General post | Existing behavior |
| News digest | What changed, audience impact, useful takeaway | Roughly 800–1500 characters where facts support it |
| Product update | Concrete release change, supported benefit, known availability | Roughly 300–1000 characters where facts support it |
| Expert article | Thesis, short sections, practical conclusion | Roughly 3000–4000 characters |
| How-to guide | Goal, ordered steps, expected result | Roughly 1000–4000 characters |

All formats obey the existing 4096-character master body limit and each channel's adaptation limit. A short channel may receive a self-contained summary rather than the full expert article. Length targets are prompt guidance, not hard guarantees. The person reviews and edits every generated draft before approval and publication.

The legacy expert pipeline described a separate SEO agent and 3000–6000-character articles. Pubrick does not claim to perform SEO research, keyword measurement, or source verification. The generation roles have no web search. A supplied URL is attribution; the run works from the stored text and never fetches the URL. The claims step only lists claims for the person to verify.

The policies are deliberately local TypeScript rules in `packages/ai/src/steps/content-type-policy.ts`: they are small product-specific prompt text, and no library would replace them. Structured output, provider calls, retries, and metering continue to use the existing AI SDK and Pubrick infrastructure.
