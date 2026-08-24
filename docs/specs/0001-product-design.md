# Pubrick — Open-Source AI Content Factory (Design)

**Date:** 2026-08-24
**Status:** Living product design (imported from the origin repo at bootstrap)
**Origin:** Extraction of the Content Factory module from Ozon-tools (atools) into a
standalone open-source product. Full rewrite (inspired by) — the atools module
(~18k LOC backend, 101 endpoints, 22 `cf_*` tables, 14 screens) serves as a
functional reference only. No data migration; atools drops the module entirely.

---

## 1. Product

**Pubrick** — an open-source AI content factory: it watches your sources (RSS,
Telegram channels), drafts on-brand posts and articles with a team of AI agents
(text + images), queues everything for human approval, publishes on schedule,
and learns from what performs.

- **Positioning:** *"Postiz schedules your content; Pubrick manufactures it."*
  The closed loop — monitoring → multi-agent generation → human review →
  publishing → analytics feedback — exists in no open-source product today
  (verified against Postiz, Mixpost, Buffer, Hootsuite, SocialBee, Typefully,
  Jasper, Copy.ai, SocialFlow, RSSHub/Huginn, SMMplanner/NovaPress).
- **Anti-slop stance is the brand:** nothing is published without a human
  decision (review queue, approval workflows) unless the owner explicitly
  enables autopilot. Brand knowledge (RAG) keeps output on-voice.
- **License:** AGPL-3.0. All code, comments, commits, and docs in English.
- **Distribution:** one public repo, one Docker image set. Runs self-hosted
  (docker compose) or as our cloud SaaS from the same codebase.
- **Monetization:** cloud SaaS with two key modes — BYOK (user's Gemini /
  OpenRouter keys) or subscription on platform keys with usage metering.
  Self-hosted = free, unlimited, BYOK by nature.
- **Name assets** (verified free 2026-08-24, to be registered by the owner
  manually): GitHub org `pubrick`, npm scope `@pubrick`, domains
  pubrick.io / pubrick.dev / pubrick.app (.com is parked by a squatter).

### Target users (in order of revenue value)

1. **Agencies / freelance SMMs** running 5–30 brands: multi-brand, roles,
   client approval links.
2. **Small-business owners / solo founders**: "a marketer for $20" — autopilot
   with approve-from-phone.
3. **Self-hosters / dev audience**: easy compose, public API, MCP, and coverage
   of X/Bluesky/Mastodon — they bring stars, contributors, and BYOK adoption.

### Platform coverage

- **Launch set (ported from reference):** Telegram (full auto), VK (full auto),
  Dzen (semi-auto), VC.ru (semi-auto), MAX. No Western tool covers Dzen/VC/MAX.
- **Early international set (moved up from roadmap):** Bluesky and Mastodon in
  P1–P2 (trivial open APIs, high credibility with the OSS audience), X next.
- **Roadmap:** LinkedIn, Facebook, Instagram, YouTube metadata.
- Adapter architecture is a plugin registry (as in the reference module); every
  platform is optional.

---

## 2. Stack (research-verified, August 2026)

| Concern | Choice | Notes |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | apps: web / api / worker |
| Frontend | Next.js 16 (UI only) | New design, Apple-style, user-friendly; advanced settings tucked away. **UI design is a separate brainstorming track.** |
| API | **NestJS 11** | Owner's choice (Postiz/Twenty pattern): modular structure, DI, OpenAPI out of the box |
| Worker | NestJS standalone app | Same DI context, separate container |
| Queue | **pg-boss v12** (Postgres-only) | cron, delayed jobs, retries, singletons; behind a thin `packages/jobs` abstraction (upgrade path: Trigger.dev v4). Self-host = 4 containers, **no Redis required** |
| DB | PostgreSQL 16 + pgvector, **Drizzle ORM** | native `vector` type, SQL migrations applied on container boot |
| AI layer | **Vercel AI SDK 7** + `@ai-sdk/google` + `@openrouter/ai-sdk-provider` | structured output via zod; OpenRouter covers embeddings and returns cost per response |
| Auth | **Better Auth** + organization plugin | email+password, Google/GitHub OAuth, orgs/teams/invitations/roles |
| Billing | own `packages/billing` interface with pluggable drivers | see §6 — provider undecided (jurisdiction question) |
| i18n | next-intl (ICU JSON), EN source of truth + ES/RU/PT | Weblate for community translations |
| Prompt mgmt / observability | DB-seeded default prompts + **optional Langfuse** (MIT core) | versioning, A/B experiments, traces; optional compose profile so bare self-host works without it |
| Email | react-email + nodemailer SMTP default, Resend driver for cloud | Documenso pattern |

### Known TS-vs-Python weak spots (accepted risks, isolated behind adapters)

1. **Telegram user-session monitoring (MTProto):** Telethon → **mtcute**
   (GramJS archived 2026-07). Young library, single author; wrap in an adapter.
2. **Article extraction:** weaker than trafilatura; acceptable (sources are
   mostly RSS/Telegram). Use `@mozilla/readability`/defuddle; `feedsmith` for
   RSS/Atom/OPML.

### Monorepo layout

```
apps/
  web/        # Next.js 16 — UI only
  api/        # NestJS — one module per domain, OpenAPI
  worker/     # NestJS standalone — pg-boss consumers (monitors, pipelines, publishing)
packages/
  db/            # Drizzle schema + SQL migrations (+pgvector)
  ai/            # provider factory, metering middleware, agents, pipelines
  jobs/          # job definitions + queue-provider abstraction
  integrations/  # platform publisher adapters (plugin registry)
  billing/       # billing interface + drivers; clean no-op when keys absent
  email/         # react-email templates + transports
  shared/        # zod schemas, types, config
docker/          # compose: web, api, worker, postgres
```

---

## 3. Data model (shape; detailed schemas at planning stage)

Tenancy: `Organization` (Better Auth org) → `Brand` (voice, audience, style,
knowledge, language of generated content — any language, not limited to UI
locales) → `Channel` (connected platform, encrypted credentials).

Content conveyor: `sources → news_items → topics → content_items (+versions)
→ adaptations (+versions) → publications`.

Supporting: `knowledge_entries` (pgvector; store `embedding_model` +
`dimensions` per entry — BYOK users may switch embedding models),
`calendar_slots`, `memorable_dates`, `media_assets` (brand media library),
`usage_ledger` (per-tenant tokens/cost; replaces `cf_budget_ledger`),
`pipeline_runs` (multi-step checkpoints; `awaiting_review` status is the
human-in-the-loop pause), prompt defaults, autopilot runs, prompt experiments.

Rules carried over from the reference module (hard-won):

- Every tenant table has `org_id NOT NULL`; all access goes through a single
  repository/query layer that injects the org filter (schema kept RLS-ready).
  Cross-brand/cross-tenant scoping bugs were a real class in the reference —
  brand-scope guards on every endpoint from day one.
- Enqueue jobs in the same DB transaction as the domain write (pg-boss makes
  this possible; Celery could not).
- Idempotent pipeline steps; stuck-job sweeper; retry policies with error
  classification (api_error / network); no nested event loops discipline
  becomes "no unawaited promises" discipline.

---

## 4. Functional scope

Target = full functionality of the reference module (inventory below), plus
the market must-haves (§4.1). Delivery is phased (§8) but the spec scope is
the whole thing.

Reference inventory (18 areas): brands; channels; news monitoring
(RSS + Telegram user-session + comments); topics bank (+AI autogen); content
generation (multi-agent: researcher/writer/editor/fact-checker/adapter, date
context, link sanitizer, per-content-type policies); image generation (inline
images, per-image regenerate, propagation to adaptations); review queue
(approve/reject/AI-revise with comments, manual edits, version history +
restore, per-platform preview, undo, hashtags); calendar (slots, AI planning,
scheduled generation, memorable dates); publishing (scheduled + immediate,
per-platform results, platform message ids, retries, stuck sweep); analytics
(metrics collection, feedback loop, prompt performance); comment analysis
(collect + AI analysis + feedback signals); knowledge base / RAG; autopilot
(full auto mode + morning digest); prompt management (versioned, A/B);
admin/settings (runtime flags, budget → usage ledger); notifications
(Telegram admin); public API.

### 4.1 Market must-haves (added 2026-08-24, owner approved)

**Mandatory (first tier):**

1. **Content repurposing** — a second pipeline entry point: URL of own blog
   post / YouTube video / newsletter → N platform-adapted posts. Same
   conveyor, different input. Early phase (P1–P2).
2. **Video as a format** — data model supports video assets in posts and
   publications from day one (attach + publish to TG/VK; Reels/Shorts later).
   AI video generation (Veo) is roadmap-only. Early phase.
3. **Roles + client approval links** — author/editor/admin roles per org;
   public share link for a draft so an external client can Approve/Comment
   without an account (the Planable feature agencies pay for). P1/P3.
4. **Public API + webhooks + MCP server** — API keys, OpenAPI (free with
   NestJS), outgoing webhooks, MCP server over the public API ("my n8n/agent
   posts via Pubrick"). P3.
5. **Brand media library** — uploaded/generated assets reusable across posts;
   stock integration (Unsplash/Pexels). P1/P3.

**Second tier (explicitly scheduled, not launch-blocking):**

6. Bluesky + Mastodon + X adapters early (P1–P2 for Bluesky/Mastodon, X after).
7. Brand onboarding wizard: website/social URL → AI derives voice, audience,
   topics (Jasper-style time-to-value).
8. Slot-based queue + best-time suggestions + per-channel timezones.
9. Evergreen recycling (categories + scheduled re-publishing).
10. Telegram approval bot (approve/reject/edit from phone) — showcase feature,
    no competitor has it.
11. Automatic UTM tagging of links in publications.

**Explicitly out (late bets, not in spec):** link-in-bio pages, white-label,
template marketplace, browser extension.

---

## 5. AI layer and key modes

One interface over AI SDK 7. `providerFor(tenant)` resolves models from tenant
credentials:

- **BYOK:** user's Gemini key and/or OpenRouter key. OpenRouter alone covers
  text + embeddings (+ images via its `/images` endpoint — thin raw client
  until the AI SDK provider supports it).
- **Platform keys (cloud subscription):** our keys, metered.

Every call passes through `wrapLanguageModel` metering middleware →
`usage_ledger` rows `{org_id, model, provider, tokens, cost, key_ownership:
'platform'|'byok', pipeline_step}`. OpenRouter returns actual USD cost in every
response (ground truth); direct Gemini uses a small versioned price table.
Subscription quotas are computed from the same ledger. BYOK rows record $0
platform cost but keep `upstreamInferenceCost` for user-facing transparency.

Agent orchestration: **no framework** — hand-rolled sequential step classes
(the reference module reached the same conclusion after dropping CrewAI).
Steps are idempotent jobs; state in `pipeline_runs`; HITL = `awaiting_review`.
Mastra (Apache-2.0) is the documented fallback if requirements outgrow this.

---

## 6. Cloud vs self-host

One repo, one image. Cloud mode activates by **presence of env keys** (Postiz
pattern): no billing keys → self-hosted install runs unlimited, no plan gating.
`packages/billing` exposes a driver interface and no-ops cleanly when disabled.

⚠️ **Open question (jurisdiction, not tech):** Stripe/Polar do not serve
Russian entities. The driver architecture keeps the choice open —
Stripe Billing Meters / Polar (MoR) / Paddle / YooKassa — to be decided when
the selling entity is known. Not a blocker for any phase before P4.

Self-hosting story (the "exemplary" bar): `docker compose up` with sane
defaults; documented `.env.example` (every var commented, optional ones
marked); migrations on boot; multi-arch images on GHCR; semver releases with
Keep-a-Changelog; `/api/health`; `DISABLE_REGISTRATION`-style hardening flags;
Railway + Coolify templates at launch; Helm deferred.

---

## 7. i18n

- UI: next-intl, ICU MessageFormat JSON, `messages/{en,es,ru,pt}.json`,
  EN = source of truth. Weblate (self-hostable, OSS-free) with GitHub
  integration for community languages. ICU plurals cover Russian.
- Generated content language: per-brand setting, any language.

---

## 8. Phases

Each phase ships a working product.

- **P0 — skeleton:** monorepo, CI, auth + organizations, brands, channels,
  Telegram publishing, review queue (minimal), docker compose, docs.
- **P1 — generation:** pipelines (news digest, expert article, educational),
  repurposing entry point, review queue full (revisions, versions, restore),
  calendar, media library (basic), video attachments, Bluesky/Mastodon,
  roles.
- **P2 — inbound:** RSS + Telegram monitoring, relevance scoring, topics
  autogen, RAG knowledge base, image generation, brand onboarding wizard, X.
- **P3 — feedback loop:** analytics + metrics collection, comment analysis,
  autopilot + morning digest, prompt A/B, public API + webhooks + MCP,
  client approval links, stock media, evergreen recycling, UTM, TG approval
  bot, slot queue/timezones.
- **P4 — cloud:** billing driver, subscriptions, quotas from usage ledger,
  cloud onboarding.
- **P5 — platform breadth:** LinkedIn, Facebook, Instagram, YouTube metadata;
  Dzen/VC deep automation.

(1–5 of §4.1 are mandatory; 6–11 are second tier — placed in phases above.)

---

## 9. Development harness (day-zero, before product code)

Based on claude.com/blog + anthropic.com/engineering guidance (Aug 2026: "The
AI-Native SDLC playbook", "Claude Code guide for startups", canonical best
practices, long-running-agents harness posts). The repo is developed primarily
with Claude Code by a solo owner + community; the harness is part of the
product's maintainability, designed before the first feature.

- **Memory:** root `CLAUDE.md` ≤ 1 page (exact commands with quiet reporters,
  conventions, architecture rationale, "Things Claude gets wrong" — grown on
  the second repeated mistake, "Verifying your work" — build/test/lint with
  pasted output, compact instructions). Per-package `CLAUDE.md` only where
  conventions genuinely differ (web / api / db). Prune test: "would removing
  this cause mistakes?".
- **Skills** (`.claude/skills/`): procedural workflows load on demand —
  `api-conventions`, `db-migrations` (Drizzle + pgvector gotchas), `release`,
  `fix-issue`, `platform-adapter` (how to add a publisher); a running
  `lessons.md` log the agent appends to, promoted into skills when patterns
  recur. Progressive disclosure: lean SKILL.md + linked files.
- **Hooks** (`.claude/settings.json`, checked in): format+lint after edits;
  block writes to generated paths (Drizzle snapshots, lockfile, dist) and
  secret patterns; bug-fix protocol (failing test committed first, test-file
  edits blocked during the fix); optional Stop hook (typecheck + affected
  tests) for unattended runs; permission allowlist for trusted commands.
- **Subagents** (`.claude/agents/`): `code-reviewer` (fresh-context diff
  review against spec/plan, "gaps, not style preferences"),
  `security-reviewer` (read-only; AGPL repo will get community PRs),
  cheap-model explorer for fan-out searches. Doer ≠ judge.
- **CI (GitHub Actions):** the same gates locally and in CI — turbo-cached
  build + typecheck + lint + vitest on every PR; claude-code-action review on
  community PRs (generated paths excluded, nits capped); eval suite built
  from real failures, triggered on changes to `CLAUDE.md` / `.claude/**` so
  harness regressions gate merges; production deploy behind human approval,
  rehearsed rollback.
- **Long-running work:** `init.sh` boots web+api+worker+postgres for a smoke
  test; JSON feature list (only `passes` mutable) + progress notes for
  multi-session build-outs; session-start orientation ritual (git log,
  progress, smoke test) stated in CLAUDE.md; git worktrees for parallel
  experiments.
- **Tooling:** prefer CLIs (`gh`, `psql`, `drizzle-kit`, `turbo`) over MCP;
  TS code-intelligence plugin from day one; package the whole harness
  (skills + hooks + agents) as a Claude Code plugin so contributors get it in
  one install.
- **Principle:** every harness component encodes an assumption about model
  limits — revisit quarterly, ask "what can we stop doing?".

## 10. Out of scope of this design

- **UI design system (Apple-style)** — separate brainstorming track before
  frontend implementation.
- Detailed table schemas, API surface, per-adapter specs — implementation
  planning stage.
- Billing provider decision (§6 open question).
