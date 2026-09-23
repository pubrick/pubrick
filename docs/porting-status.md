# Reference module porting status

This is a working inventory, not a release promise. The reference is
`Ozon-tools/backend/app/content_factory` and `frontend/src/app/content`;
the target is this repository. The product scope and phases remain in
`docs/specs/0001-product-design.md` §4 and §8. Code wins over older design
documents when they disagree.

| Reference area | Pubrick today | Next meaningful gap |
|---|---|---|
| Brands | Present | Brand onboarding wizard |
| Channels | Telegram, VK and MAX delivery; VC.ru manual publication workflow | Other platform adapters and per-platform media |
| News monitoring | Brand-scoped RSS, Atom, RDF, JSON Feed and public Telegram channel sources, polling, story list, advisory AI relevance scoring and draft start | Private invite-only Telegram channels and feedback-informed ranking |
| Topics bank | Brand-scoped human-reviewed ideas, import from watched articles, approval, edit/archive and generation via existing runs | AI topic suggestions and planning |
| Multi-agent generation | Five-step engine, run receipts, current UTC date in every model step, and a public article URL preview that feeds the existing multi-channel run | Content-type pipelines, video/newsletter repurposing and link policy |
| Images and media | Brand-scoped upload library, manual Gemini image generation and per-image variation, cover selection and Telegram photo delivery | Other channel media and richer image provenance |
| Review queue | Manual edits, approval, refine, provenance, saved version history and channel re-adaptation | Comments, per-platform previews and richer revisions |
| Calendar | Scheduled publishing, brand calendar, slots and planned draft generation | Memorable dates and richer planning |
| Publishing | Telegram, VK and MAX delivery with retry and outcome reconciliation; VC.ru copy and self-reported URL; opt-in public RSS syndication | Native delivery for other platforms and verified Dzen ingestion support |
| Analytics | Usage and cost ledger present | Channel metrics, content performance and feedback |
| Comment analysis | On-demand, brand-scoped sample of up to 50 Telegram replies per public channel post | Metered BYOK summary, sentiment analysis and feedback signals |
| Knowledge base / RAG | Brand notes, CSV import, optional Gemini indexing and hybrid retrieval in generation | Migration of old notes, automatic indexing and source citations |
| Autopilot | Not ported | Guardrails, digest and explicit owner-controlled automation |
| Prompt management | Built-in role prompts plus versioned, organization-scoped guidance | Version pinning on retries and experiments |
| Admin and settings | Basic organization and BYOK settings present | Runtime flags and operational controls |
| Notifications | Not ported | Actionable admin notifications |
| Public API | Internal authenticated API present | Public keys, documented endpoints, webhooks and MCP |
| Additional reference utilities | Uploads present | Link sanitization and cross-channel media propagation |

The nearest dependency chain follows the generation design's shipping order:
Add feedback-informed ranking on top of the shared feed and Telegram source
inventory, advisory AI scores, and human-reviewed topics. A topic uses the existing generation engine rather
than a second generation path. The public RSS output is available for
syndication, but it does not assert that Dzen imported a post.

Every ported slice should be usable on its own, tenant-scoped, metered when it
calls a model, translated in all four locales, tested locally, and described in
English. Reference behaviour is a guide; Pubrick's published safety and design
rules take precedence where the old implementation differs.
