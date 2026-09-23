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
| Topics bank | Brand-scoped human-reviewed ideas, article import, AI topic suggestions from bank and scored news, approval, edit/archive and generation via existing runs | Editorial planning calendar |
| Multi-agent generation | Five-step engine, run receipts, current UTC date in every model step, public article URL preview, and selected social post/news digest/expert article/how-to formats | Video/newsletter repurposing, link policy and deeper SEO workflow |
| Images and media | Brand-scoped upload library, manual Gemini image generation and per-image variation, cover selection and Telegram photo delivery | Other channel media and richer image provenance |
| Review queue | Manual edits, approval, refine, provenance, saved version history and channel re-adaptation | Comments, per-platform previews and richer revisions |
| Calendar | Scheduled publishing, brand calendar, slots and planned draft generation | Memorable dates and richer planning |
| Publishing | Telegram, VK and MAX delivery with retry and outcome reconciliation; VC.ru copy and self-reported URL; opt-in public RSS syndication | Native delivery for other platforms and verified Dzen ingestion support |
| Analytics | Usage and cost ledger; brand results and on-demand VK post metrics | Automatic collection, other-channel metrics and performance feedback |
| Comment analysis | On-demand public Telegram reply sample and metered Google BYOK aggregate summary, sentiment and themes | Private or inaccessible discussions and feedback-informed ranking |
| Knowledge base / RAG | Brand notes, CSV import, optional Gemini indexing, hybrid retrieval and selected-note links in run receipts | Migration of old notes, automatic indexing and claim-level source citations |
| Autopilot | Owner-controlled scheduled draft generation from approved topics, with per-brand quota and spend admission threshold | Morning digest, richer planning and review signals |
| Prompt management | Built-in role prompts plus versioned, organization-scoped guidance | Version pinning on retries and experiments |
| Admin and settings | Basic organization and BYOK settings present | Runtime flags and operational controls |
| Notifications | Not ported | Actionable admin notifications |
| Public API | Internal authenticated API present | Public keys, documented endpoints, webhooks and MCP |
| Additional reference utilities | Uploads present | Link sanitization and cross-channel media propagation |

News scores and AI topic suggestions remain advisory; an editor chooses and
approves each topic before generation. The public RSS output is available for
syndication, but it does not assert that Dzen imported a post.

Every ported slice should be usable on its own, tenant-scoped, metered when it
calls a model, translated in all four locales, tested locally, and described in
English. Reference behaviour is a guide; Pubrick's published safety and design
rules take precedence where the old implementation differs.
