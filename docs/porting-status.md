# Reference module porting status

This is a working inventory, not a release promise. The reference is
`Ozon-tools/backend/app/content_factory` and `frontend/src/app/content`;
the target is this repository. The product scope and phases remain in
`docs/specs/0001-product-design.md` §4 and §8. Code wins over older design
documents when they disagree.

| Reference area | Pubrick today | Next meaningful gap |
|---|---|---|
| Brands | Guided manual setup with name, source-targeting description, voice, audience and content language; profile editing and next-step links | Optional website/social import with reviewed AI suggestions |
| Channels | Telegram, VK, MAX, Bluesky and Mastodon delivery; VC.ru manual publication workflow | Other platform adapters and channel-specific publishing options |
| News monitoring | Brand-scoped RSS, Atom, RDF, JSON Feed, public Telegram channels and joined private Telegram broadcast channels with in-app setup; polling, story list, advisory AI relevance scoring and draft start | Feedback-informed ranking and discussion groups |
| Topics bank | Brand-scoped human-reviewed ideas, article import, AI topic suggestions from bank and scored news, approval, edit/archive, direct generation and approved-topic calendar links | Richer editorial feedback and bulk planning |
| Multi-agent generation | Five-step engine, run receipts, current UTC date in every model step, public article URL preview, selected social post/news digest/product update/expert article/how-to/source retelling/comparison/case study formats, and opt-in homepage UTM tagging | Video/newsletter repurposing and deeper SEO workflow |
| Images and media | Brand-scoped upload library, manual Gemini image generation and per-image variation, cover selection and Telegram/VK/MAX/Bluesky photo delivery | Richer image provenance and additional media formats |
| Review queue | Manual edits, approval, refine, provenance, saved version history, channel re-adaptation and literal per-channel review previews | Comments and richer revisions |
| Calendar | Scheduled publishing, brand calendar, brief or approved-topic slots with stale-topic checks, planned draft generation and brand-scoped annual memorable-date suggestions | Richer planning and bulk slot creation |
| Publishing | Telegram, VK, MAX, Bluesky and text-only Mastodon delivery with retry and outcome reconciliation; VC.ru copy and self-reported URL; opt-in public RSS syndication | Native delivery for other platforms and verified Dzen ingestion support |
| Analytics | Usage and cost ledger; brand results, on-demand VK post metrics and opt-in background VK collection | Other-channel metrics and performance feedback |
| Comment analysis | On-demand public Telegram reply sample and metered Google BYOK aggregate summary, sentiment and themes | Private or inaccessible discussions and feedback-informed ranking |
| Knowledge base / RAG | Brand notes, portable CSV import/export preserving paused state and literal tags, optional single or batch Gemini indexing, embedding-model provenance, hybrid retrieval, selected-note links and validated source excerpts in run receipts | Automatic indexing and independent claim verification |
| Autopilot | Owner-controlled scheduled draft generation from approved topics, with per-brand quota and spend admission threshold | Richer planning and review signals |
| Prompt management | Built-in role prompts plus versioned organization guidance, pinned to each generation run at first claim | Controlled prompt experiments |
| Admin and settings | Basic organization and BYOK settings present | Runtime flags and operational controls |
| Notifications | Org-scoped Telegram bot and chat, encrypted at rest, opt-in draft alerts, delivery failure/unknown alerts, per-brand daily digest, Test action, durable at-most-once outbox | Richer event preferences and delivery history UI |
| Public API | Internal authenticated API present | Public keys, documented endpoints, webhooks and MCP |
| Additional reference utilities | Uploads, safe homepage link tagging and one-cover propagation across Telegram/VK/MAX/Bluesky | Multiple media attachments and format-specific reuse |

News scores and AI topic suggestions remain advisory; an editor chooses and
approves each topic before generation. The public RSS output is available for
syndication, but it does not assert that Dzen imported a post.

Every ported slice should be usable on its own, tenant-scoped, metered when it
calls a model, translated in all four locales, tested locally, and described in
English. Reference behaviour is a guide; Pubrick's published safety and design
rules take precedence where the old implementation differs.
