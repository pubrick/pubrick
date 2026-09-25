<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="Pubrick" width="360">
  </picture>
</p>

<p align="center"><strong>The open-source AI content factory.</strong></p>

<p align="center"><em>From your sources to published posts — with you in the loop.</em></p>

<p align="center">
  <a href="https://github.com/pubrick/pubrick/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/pubrick/pubrick/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-E67131"></a>
  <img alt="Made with TypeScript" src="https://img.shields.io/badge/made%20with-TypeScript-0F0F0F">
  <img alt="Self-host with Docker Compose" src="https://img.shields.io/badge/self--host-docker%20compose-0F0F0F">
</p>

---

Pubrick watches RSS, web feeds, and Telegram sources, drafts on-brand posts
with AI agents, queues them for **your** approval, and publishes approved posts
on schedule. Brand knowledge, manual image generation, opt-in draft cover
generation, Telegram video attachments, and VK performance metrics are available
in the current pre-alpha.

**Status: pre-alpha.** Working today: accounts and sessions, organizations,
brands — each with a voice, an audience and a content language the generator is
instructed with — and channels with credentials encrypted at rest, plus content
drafts, a review queue with approval/rejection/overrides, and publishing to
Telegram, VK communities, MAX chats or channels, Bluesky accounts, and Mastodon instances — through a restyled,
installable (PWA) web app. [VC.ru, Dzen, Instagram, YouTube, RuTube and TenChat](docs/manual-publications.md)
use a manual copy and confirmation workflow. External clients can review a
draft through an [expiring approval link](docs/client-review.md), while the team
keeps [editorial notes](docs/editorial-notes.md) on saved versions. Editors can
request a [metered whole-draft rewrite](docs/editorial-notes.md#whole-draft-ai-revision), compare
it with the saved text, and explicitly accept or discard it. AI
generation works too, with
**your own** Gemini or OpenRouter key (there is no hosted key): start from a
brief or schedule a draft in the [brand calendar](docs/calendar.md). Five roles —
researcher, writer, editor, a fact-checker that lists claims to verify rather
than checking them, and one adapter per channel — produce a draft with
per-channel copy and an origin badge, while Settings shows what your key has
spent. Nothing publishes that no human has opened or edited. Model calls are
metered, including retries and failures after the provider counted tokens;
calls whose ledger write fails are counted as unpriced rather than shown as
zero spend. RSS, Atom, RDF, and JSON feeds can be watched per
brand; an article's title and summary can start a draft. You can also
[request an advisory claim review](docs/claim-review.md) for a saved draft:
Pubrick searches public results on your organization key, shows linked snippets,
and leaves the text and final judgment with the editor. You can
[fetch a public article into an editable preview](docs/source-extraction.md) and
generate [social posts, news digests, product updates, expert articles, how-to guides, source-based retellings, comparisons, or case studies](docs/content-types.md)
for selected channels. See [watched sources](docs/watched-sources.md)
for the exact limits. The per-brand
knowledge base supports portable CSV import/export, text search, and optional
Gemini vector indexing, including [opt-in automatic backfill](docs/brand-knowledge.md).
The [media library](docs/media-library.md) accepts reviewed MP4 uploads for
Telegram video posts and optional Gemini covers generated with a new draft.
Editors can also place [images inside articles](docs/article-images.md), with
escaped previews and immutable image snapshots in the opt-in public RSS feed.
Organization owners and admins can issue one-time
[public read API](docs/public-api.md) keys for tenant-scoped content reads and
[assign per-brand access](docs/brand-access.md) to authors, editors and regular
members. Authors can prepare drafts; editors can approve and publish for their
assigned brands. The
[OpenAPI contract](docs/openapi-v1.json) describes that limited surface, and an
[optional MCP server](docs/mcp.md) exposes the same reads to local AI tools. Other
platforms remain unavailable until a safe publishing workflow is implemented.
Features land phase by phase — see
[docs/specs/0001-product-design.md](docs/specs/0001-product-design.md).

Public RSS syndication is available for selected published posts; see
[docs/public-rss.md](docs/public-rss.md). It does not confirm delivery to Dzen.
Organizations can also opt in to [Telegram notifications](docs/notifications.md)
for drafts awaiting review and delivery problems.
[Outgoing webhooks](docs/webhooks.md) can send signed publication outcomes to
your own HTTPS endpoint, with delivery history and explicit unknown outcomes.

## Why Pubrick

- **Human-in-the-loop by design** — every post needs approval before publishing.
  Owners can opt in to scheduled draft generation from approved topics, while
  publication still requires a person to review and approve the result.
- **Brand voice** — voice, audience and content language are set per brand and
  go into every generation's instructions, so drafts sound like you rather than
  like a model. Brand knowledge notes can be selected as material for a draft;
  see [brand knowledge](docs/brand-knowledge.md).
- **Bring your own keys** — Gemini and OpenRouter (hundreds of models);
  self-hosted generation at your own API cost.
- **Own it** — AGPL-3.0, docker compose, Postgres as the only stateful service.

## Quickstart (self-hosted)

Requires Docker with Compose v2.

```bash
git clone https://github.com/pubrick/pubrick && cd pubrick
cp .env.example .env

# Generate two separate secrets and paste them into .env, replacing the
# placeholder values of BETTER_AUTH_SECRET and APP_ENCRYPTION_KEY:
openssl rand -base64 32
openssl rand -base64 32

# Set POSTGRES_PASSWORD in .env too, then start:
docker compose up -d
```

Compose ships no fallback secrets, so it refuses to start on an *unset*
`BETTER_AUTH_SECRET` or `APP_ENCRYPTION_KEY` — but leaving either as the
placeholder text above is a value, not an unset one, and only the api itself
catches that, at its own boot. Skip the two `openssl` lines and the api
crash-loops instead of running on a key public in this repository; check
`docker compose logs api` if the site does not come up. Details, and why the
web container won't come up behind it either, in
[docs/self-hosting.md](docs/self-hosting.md#install).

Web: http://localhost:3000 · API health: http://localhost:3001/api/health
(both configurable — see the "Ports" section of
[.env.example](.env.example) if either is already taken on your host)

`APP_ENCRYPTION_KEY` encrypts channel credentials at rest — back it up, because
losing it makes every stored credential unreadable. To rotate it, put the new
key first and keep the old one behind it (`new,old`); nothing has to be
rewritten first. Full notes, including TLS and `PUBLIC_ORIGIN`, in
[docs/self-hosting.md](docs/self-hosting.md).

## Development

Node 22 + pnpm (corepack) + Docker. `./init.sh` boots the dev stack: Postgres in
Docker, migrations, then api (:3001), worker and web (:3000) locally.

Gates: `pnpm typecheck && pnpm lint && pnpm test` — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Brand assets

The wordmark, the brick mark and the social card live in [`assets/`](assets/).
Palette: ink `#0F0F0F`, brick `#E67131`, paper `#F5F6F7`.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
