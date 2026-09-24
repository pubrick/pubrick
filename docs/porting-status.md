# Reference module porting status

This is a working inventory, not a release promise. The reference is
`Ozon-tools/backend/app/content_factory` and `frontend/src/app/content`;
the target is this repository. The product scope and phases remain in
`docs/specs/0001-product-design.md` §4 and §8. Code wins over older design
documents when they disagree.

| Reference area | Pubrick today | Next meaningful gap |
|---|---|---|
| Brands | Guided manual setup with name, source-targeting description, voice, audience and content language; profile editing and next-step links | Optional website/social import with reviewed AI suggestions |
| Organization roles | Workspace owner/admin/member checks; explicit per-brand access for regular members with owner/admin management and filtered brand resources; owner/admin control of external review links | Product-specific author/editor permissions |
| Channels | Telegram, VK, MAX, Bluesky and Mastodon delivery; VC.ru manual publication workflow | Verify the legacy VC.ru API before offering opt-in native delivery; then channel-specific options |
| News monitoring | Brand-scoped RSS, Atom, RDF, JSON Feed, public Telegram channels and joined private Telegram broadcast channels with owner/admin account sign-in in Settings; polling, story list, advisory AI relevance scoring, metered semantic editor-feedback ranking with lexical fallback, and draft start | Discussion groups and richer editorial feedback |
| Topics bank | Brand-scoped human-reviewed ideas, article import, AI topic suggestions from bank and scored news, approval, edit/archive, target date and priority, direct generation and approved-topic calendar links with reviewed bulk planning | Richer topic performance feedback |
| Multi-agent generation | Five-step engine, run receipts, current UTC date in every model step, public article URL preview, selected social post/news digest/product update/expert article/how-to/source retelling/comparison/case study formats, and opt-in homepage UTM tagging | Video/newsletter repurposing and deeper SEO workflow |
| Images and media | Brand-scoped image and MP4 upload library, manual Gemini image generation and per-image variation, opt-in Gemini cover generation for manual and scheduled draft runs, one-attachment selection, review preview, Telegram/VK video delivery and Telegram/VK/MAX/Bluesky photo delivery; editor-managed inline image slots with safe attachment/removal and RSS snapshots | Automatic per-slot generation and regeneration, richer image provenance and later video formats |
| Review queue | Manual edits, approval, selection refinement, provenance, saved version history, channel re-adaptation and literal per-channel review previews; expiring guest client-review links with exact-draft approval gate; internal snapshot-bound editorial notes with opt-in style guidance for new drafts; metered whole-draft AI suggestions with explicit Accept/Discard; archive and restore with preserved publication receipts; confirmed permanent deletion of new archived drafts with no delivery or retained generation run | Retained-run redaction and historical receipt provenance before broadening deletion; optional joint rewrite of master and channel variants |
| Calendar | Scheduled publishing, brand calendar, brief or approved-topic slots with stale-topic checks, operator-confirmed bulk planning and opt-in automatic or owner/admin-triggered placement of dated approved topics, planned draft generation and brand-scoped annual memorable-date suggestions | Recurring plans and richer scheduling signals |
| Publishing | Telegram, VK, MAX, Bluesky and text-only Mastodon delivery with retry and outcome reconciliation; VC.ru copy and self-reported URL; opt-in public RSS syndication with snapshotted article images | Verify VC.ru native delivery and Dzen ingestion before claiming either succeeded; package inline images for manual VC.ru posting |
| Analytics | Usage and cost ledger; brand results, on-demand VK post metrics and opt-in background VK collection | Analysis of comments on owned Telegram posts, other-channel metrics and performance feedback |
| Comment analysis | On-demand public Telegram reply sample and metered Google BYOK aggregate summary, sentiment and themes | Private or inaccessible discussions and analytics feedback |
| Knowledge base / RAG | Brand notes, portable CSV import/export preserving paused state and literal tags, manual Gemini indexing plus opt-in bounded hourly vector backfill, embedding-model provenance, hybrid retrieval, selected-note links and validated source excerpts in run receipts | Independent claim verification and relevance evaluation |
| Autopilot | Owner-controlled scheduled draft generation from approved undated topics, with per-brand quota and spend admission threshold; separate opt-in daily AI topic ideas that still need editor approval; opt-in hourly and owner/admin-triggered calendar planning of approved dated topics with a daily slot limit | Richer review signals and operator diagnostics |
| Prompt management | Built-in role prompts plus versioned organization guidance, pinned to each generation run at first claim | Prompt outcome scoring and controlled experiments |
| Admin and settings | Organization and BYOK controls, owner/admin Telegram source-account connection, plus typed per-brand autopilot, metric collection, knowledge indexing and notification settings | Operator diagnostics and safe manual task triggers |
| Notifications | Org-scoped Telegram bot and chat, encrypted at rest, opt-in draft alerts, delivery failure/unknown alerts, per-brand daily digest, Test action, durable at-most-once outbox | Richer event preferences and delivery history UI |
| Public API and events | Owner/admin-managed hashed organization keys, one-time secret reveal, documented Bearer-only read endpoints for scoped content list/detail and tenant-safe pagination, OpenAPI 3.1 contract, optional read-only MCP stdio server; signed publication outcome webhooks with transactional outbox and delivery history | Additional read scopes and event types |
| Additional reference utilities | Uploads, safe homepage link tagging and one-cover propagation across Telegram/VK/MAX/Bluesky | Multiple media attachments and format-specific reuse |

News scores and AI topic suggestions remain advisory; an editor chooses and
approves each topic before generation. The public RSS output is available for
syndication, but it does not assert that Dzen imported a post.

The reference exposed a generic `CF_*` override endpoint. Pubrick uses typed,
validated brand controls for the live operations it covers: scheduled draft
generation, daily quota and spend threshold, quiet hours, background VK metrics,
knowledge indexing, and notifications. A raw flag editor would bypass those
contracts. The reference's automatic publication switch conflicts with
Pubrick's human approval gate and is not a planned direct port.

The reference's Instagram, YouTube, RuTube, TenChat and T—Ж publishers were
manual placeholders. Its video generator and Shorts flow were design notes,
not working code. The only substantial reference publisher still absent here
is the VC.ru token adapter; its success path lacks a recorded integration test,
so the manual Pubrick workflow remains the trustworthy option until verified.

Every ported slice should be usable on its own, tenant-scoped, metered when it
calls a model, translated in all four locales, tested locally, and described in
English. Reference behaviour is a guide; Pubrick's published safety and design
rules take precedence where the old implementation differs.
