# Editorial formats in generation

Pubrick can generate a social post, news digest, source retelling, product update, expert article, comparison, case study, or how-to guide. Choose **Generate as** on the New post screen. Source retelling and case study require pasted or explicitly accepted source text; other formats can start from a brief, source text, or both. The selected format is saved in the run input and displayed on its receipt; retry uses the same format. Older runs with no format field remain social posts.

This ports the legacy Content Factory's `news_digest`, `repost`, `product_update`, `expert_article`, `comparison`, `case_study`, and `educational` intents into Pubrick's existing researcher → writer → editor → claims-to-verify → per-channel adapter pipeline. The legacy `repost` and `product_update` use the news digest pipeline, while `comparison` and `case_study` use the expert article pipeline. Pubrick gives each a distinct policy within the same five-step engine. The format changes trusted role guidance, not the pipeline, queue, model selection, or billing path. Every physical language-model call continues through the same metered step runner. Runs remain scoped to the active organization and brand by the existing repository.

| Format | Editorial goal | Master draft constraint |
| --- | --- | --- |
| Social post | General post | Existing behavior |
| News digest | What changed, audience impact, useful takeaway | Roughly 800–1500 characters where facts support it |
| Source retelling | Reframe supplied text for the brand's audience, preserving its supported main point | Concise; within the channel limit |
| Product update | Concrete release change, supported benefit, known availability | Roughly 300–1000 characters where facts support it |
| Expert article | Thesis, short sections, practical conclusion | Roughly 3000–4000 characters |
| Comparison | Shared criteria, supported trade-offs, evidence gaps | Within the 4096-character master limit |
| Case study | Documented situation, actions, supported outcome | Roughly 1500–4000 characters where source facts support it |
| How-to guide | Goal, ordered steps, expected result | Roughly 1000–4000 characters |

All formats obey the existing 4096-character master body limit and each channel's adaptation limit. A short channel may receive a self-contained summary rather than the full expert article. Length targets are prompt guidance, not hard guarantees. The person reviews and edits every generated draft before approval and publication.

Source retelling (`repost`) is a new draft from stored source text, not a native share, and the source URL is optional attribution on the run receipt. Its instructions ask for fresh wording and avoidance of long copied passages, but Pubrick does not check similarity, originality, copyright status, or factual accuracy. Comparison can start from a brief; without evidence for concrete product claims it should discuss criteria and trade-offs rather than rank options or report invented benchmarks. Case study requires source text so a customer, result, or endorsement cannot be inferred from an empty brief. These are prompt instructions, not verification. The person must review every claim and source before approving a draft. The legacy expert pipeline described a separate SEO agent and 3000–6000-character articles. Pubrick does not claim to perform SEO research, keyword measurement, or source verification. The generation roles have no web search. A supplied URL is attribution; the run works from the stored text and never fetches the URL. The claims step only lists claims for the person to verify.

The policies are deliberately local TypeScript rules in `packages/ai/src/steps/content-type-policy.ts`: they are small product-specific prompt text, and no library would replace them. Structured output, provider calls, retries, and metering continue to use the existing AI SDK and Pubrick infrastructure.

The editor may include a 0–1 self-rating in its existing structured response. The queue shows this as an advisory percentage when present; older checkpoints, human drafts, and editor responses without a rating remain unrated. It is the editor model's assessment at generation time, before the claims-to-verify step. It is not recalculated after human edits and is not measured or verified post-fact-check quality. It does not affect approval, publishing, or preflight decisions and adds no model call.

The brand activity overview shows the mean of scored drafts created in its selected 7, 30, or 90-day window and the number of drafts behind that mean. Drafts without a score are excluded, and a window with no scored drafts returns a null mean. The aggregate is still a model self-rating, not a measure of factual accuracy or editorial outcomes.
