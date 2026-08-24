<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="Pubrick" width="360">
  </picture>
</p>

<p align="center"><strong>The open-source AI content factory.</strong></p>

<p align="center"><em>Postiz schedules your content. Pubrick manufactures it.</em></p>

<p align="center">
  <a href="https://github.com/pubrick/pubrick/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/pubrick/pubrick/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-E67131"></a>
  <img alt="Made with TypeScript" src="https://img.shields.io/badge/made%20with-TypeScript-0F0F0F">
  <img alt="Self-host with Docker Compose" src="https://img.shields.io/badge/self--host-docker%20compose-0F0F0F">
</p>

---

Pubrick watches your sources (RSS, Telegram channels), drafts on-brand posts and
articles with a team of AI agents — text and images — queues everything for
**your** approval, publishes on schedule, and learns from what performs.

**Status: pre-alpha.** Working today: accounts and sessions, organizations,
brands, and channels with credentials encrypted at rest. Next up: the publishing
pipeline (sources → drafts → approval → scheduled delivery). Features land phase
by phase — see [docs/specs/0001-product-design.md](docs/specs/0001-product-design.md).

## Why Pubrick

- **Human-in-the-loop by design** — nothing is published without approval
  unless you explicitly enable autopilot. Anti-slop is the point.
- **Brand knowledge** — a per-brand knowledge base (RAG) keeps output on-voice.
- **Bring your own keys** — Gemini and OpenRouter (hundreds of models);
  self-hosted generation at your own API cost.
- **Own it** — AGPL-3.0, docker compose, Postgres as the only stateful service.

## Quickstart (self-hosted)

Requires Docker with Compose v2.

```bash
git clone https://github.com/pubrick/pubrick && cd pubrick
cp .env.example .env

# Generate both secrets BEFORE starting — compose has no fallback defaults and
# refuses to boot without them. Use a fresh value for each:
echo "BETTER_AUTH_SECRET=$(openssl rand -base64 32)" >> .env
echo "APP_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env

# Then edit .env: drop the two REPLACE_ME_… placeholder lines that came from
# .env.example, and set a real POSTGRES_PASSWORD.

docker compose up -d
```

Web: http://localhost:3000 · API health: http://localhost:3001/api/health

`APP_ENCRYPTION_KEY` encrypts channel credentials at rest — back it up, because
losing or rotating it makes every stored credential unreadable. Full notes,
including TLS and `PUBLIC_ORIGIN`, in [docs/self-hosting.md](docs/self-hosting.md).

## Development

Node 22 + pnpm (corepack) + Docker. `./init.sh` boots the dev stack: Postgres in
Docker, migrations, then api (:3001), worker and web (:3000) locally.

Gates: `pnpm typecheck && pnpm lint && pnpm test` — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Brand assets

The wordmark, the brick mark and the social card live in [`assets/`](assets/).
Palette: ink `#0F0F0F`, brick `#E67131`, paper `#F5F6F7`.

## License

AGPL-3.0-only. See [LICENSE](LICENSE).
