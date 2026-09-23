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
| News monitoring | Brand-scoped RSS, Atom, RDF and JSON Feed sources, polling, article list, advisory AI relevance scoring and draft start | Telegram sources and feedback-informed ranking |
| Topics bank | Brand-scoped human-reviewed ideas, import from watched articles, approval, edit/archive and generation via existing runs | AI topic suggestions and planning |
| Multi-agent generation | Five-step engine and run receipts present | Content-type pipelines, repurposing, date context and link policy |
| Image generation | Not ported | Media storage, generation and per-image regeneration |
| Review queue | Manual edits, approval, refine, provenance, saved version history and channel re-adaptation | Comments, per-platform previews and richer revisions |
| Calendar | Scheduled publishing present | Calendar view, slots and planned generation |
| Publishing | Telegram, VK and MAX delivery with retry and outcome reconciliation; VC.ru copy and self-reported URL; opt-in public RSS syndication | Native delivery for other platforms and verified Dzen ingestion support |
| Analytics | Usage and cost ledger present | Channel metrics, content performance and feedback |
| Comment analysis | Not ported | Collection, analysis and feedback signals |
| Knowledge base / RAG | Not ported | Brand documents, retrieval and citation in generation |
| Autopilot | Not ported | Guardrails, digest and explicit owner-controlled automation |
| Prompt management | Prompts live in code | Versioned registry and experiments |
| Admin and settings | Basic organization and BYOK settings present | Runtime flags and operational controls |
| Notifications | Not ported | Actionable admin notifications |
| Public API | Internal authenticated API present | Public keys, documented endpoints, webhooks and MCP |
| Additional reference utilities | Partial | Uploads, link sanitization and cross-channel media propagation |

The nearest dependency chain follows the generation design's shipping order:
add Telegram sources and feedback-informed ranking on top of the RSS source inventory,
advisory AI scores, and human-reviewed topics. A topic uses the existing generation engine rather
than a second generation path. The public RSS output is available for
syndication, but it does not assert that Dzen imported a post.

Every ported slice should be usable on its own, tenant-scoped, metered when it
calls a model, translated in all four locales, tested locally, and described in
English. Reference behaviour is a guide; Pubrick's published safety and design
rules take precedence where the old implementation differs.
