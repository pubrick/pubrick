# Reference module porting status

This is a working inventory, not a release promise. The reference is
`Ozon-tools/backend/app/content_factory` and `frontend/src/app/content`;
the target is this repository. The product scope and phases remain in
`docs/specs/0001-product-design.md` §4 and §8. Code wins over older design
documents when they disagree.

| Reference area | Pubrick today | Next meaningful gap |
|---|---|---|
| Brands | Guided manual setup with name, source-targeting description, voice, audience and content language; profile editing and next-step links; optional public-website import with reviewed Gemini suggestions and explicit save | Public social-profile import when a verifiable platform API is available |
| Organization roles | Workspace owner/admin/member checks; explicit per-brand access for regular members with owner/admin management and filtered brand resources; owner/admin control of external review links | Product-specific author/editor permissions |
| Channels | Telegram, VK, MAX, Bluesky and Mastodon delivery; VC.ru manual publication with a downloadable reviewed article and image package | Verify the legacy VC.ru API before offering opt-in native delivery; then channel-specific options |
| News monitoring | Brand-scoped RSS, Atom, RDF, JSON Feed, public Telegram channels and joined private Telegram broadcast channels with owner/admin account sign-in in Settings; polling, story list, advisory AI relevance scoring, metered semantic editor-feedback ranking with lexical fallback, explicit bounded update of existing rankings without new AI calls, owner/admin initiated paid relevance recheck of up to 500 recent scored stories with durable progress, and draft start | Discussion groups and richer editorial feedback |
| Topics bank | Brand-scoped human-reviewed ideas, article import, AI topic suggestions from bank and scored news, approval, edit/archive, target date and priority, direct generation with an expert-article keyword option, and approved-topic calendar links with reviewed bulk planning | Persisting topic keywords for scheduled runs and richer topic performance feedback |
| Multi-agent generation | Five-step default engine, run receipts, current UTC date in every model step, public article URL preview, selected social post/news digest/product update/expert article/how-to/source retelling/comparison/case study formats, opt-in homepage UTM tagging, and an optional metered SEO editorial pass for expert articles with reviewed keywords and visible fallback | Scheduled-topic keyword propagation, video/newsletter repurposing and evidence-based SEO evaluation |
| Images and media | Brand-scoped image and MP4 upload library, manual Gemini image generation and per-image variation, opt-in Gemini covers for manual and scheduled draft runs, opt-in automatic illustrations for direct and scheduled long-form runs with an approval review gate, one-click regeneration of a chosen inline slot, one-attachment selection, Telegram/VK video delivery and Telegram/VK/MAX/Bluesky photo delivery; editor-managed inline image slots with safe attachment/removal and RSS snapshots | Richer image provenance and later video formats |
| Review queue | Manual edits, approval, selection refinement, provenance, saved version history, channel re-adaptation and literal per-channel review previews; structured channel hashtags in the canonical sent body and editorial-only CTA notes, both versioned; expiring guest client-review links with exact-draft approval gate; internal snapshot-bound editorial notes with opt-in style guidance for new drafts; metered whole-draft AI suggestions with explicit Accept/Discard; on-demand advisory claim review with linked search snippets and saved-body staleness; archive and restore with preserved publication receipts; confirmed permanent deletion of new archived drafts with no delivery or retained generation run | Retained-run redaction and historical receipt provenance before broadening deletion; optional joint rewrite of master and channel variants |
| Calendar | Scheduled publishing, brand calendar, brief or approved-topic slots with stale-topic checks, operator-confirmed bulk planning and opt-in automatic or owner/admin-triggered placement of dated approved topics, planned draft generation and brand-scoped annual memorable-date suggestions | Recurring plans and richer scheduling signals |
| Publishing | Telegram, VK, MAX, Bluesky and text-only Mastodon delivery with retry and outcome reconciliation; VC.ru copy, portable HTML/JPEG ZIP, and self-reported URL; opt-in public RSS syndication with snapshotted article images | Verify VC.ru native delivery and Dzen ingestion before claiming either succeeded |
| Analytics | Usage and cost ledger; brand-scoped observed activity overview (drafts, runs, decisions, publication receipts, attributed spend); brand results, on-demand VK post metrics and opt-in background VK collection; on-demand bounded reply samples and metered AI synthesis for owned Telegram publications | Other-channel metrics and performance feedback; full historical brand attribution for deleted records |
| Comment analysis | On-demand public Telegram reply samples for source stories and publications; separate default-off, free hourly collection settings for eligible source stories and owned published posts; separate manual metered Google BYOK summary, sentiment and themes | Private or inaccessible discussions, paid automatic analysis and analytics feedback |
| Knowledge base / RAG | Brand notes, portable CSV import/export preserving paused state and literal tags, manual Gemini indexing plus opt-in bounded hourly vector backfill, embedding-model provenance, hybrid retrieval, selected-note links and validated source excerpts in run receipts; separate on-demand public-search claim evidence for saved drafts | Relevance evaluation tied to outcomes and richer source verification |
| Autopilot | Owner-controlled scheduled draft generation from approved undated topics, with per-brand quota and spend admission threshold; separate opt-in daily AI topic ideas that still need editor approval; opt-in hourly and owner/admin-triggered calendar planning of approved dated topics with a daily slot limit; read-only daily diagnostics for usage, eligible-looking topics, active runs and recent dispatches; guarded manual generation checks with durable decisions; durable brand-scoped scheduled admission decisions (skip, dispatch and safe failure) with bounded 14-day history | More detailed operator recovery and generation outcome links |
| Prompt management | Built-in role prompts plus versioned organization guidance, pinned to each generation run at first claim; per-revision observed run and current draft status counts; append-only historical human review decisions with verified pinned-revision attribution and bounded manager-only timelines | Controlled experiments; the legacy A/B resolver had no production caller |
| Admin and settings | Organization and BYOK controls, owner/admin Telegram source-account connection, typed per-brand autopilot, metric collection, knowledge indexing and notification settings; scoped Autopilot diagnostics, scheduled admission history and manual generation checks with durable decisions | Remaining manual task triggers and richer operator history |
| Notifications | Org-scoped Telegram bot and chat, encrypted at rest, opt-in draft alerts, delivery failure/unknown alerts, per-brand daily digest, Test action, durable at-most-once outbox and read-only delivery history | Richer event preferences and delivery diagnostics |
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
