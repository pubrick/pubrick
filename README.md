# Pubrick

**The open-source AI content factory.** Pubrick watches your sources (RSS,
Telegram channels), drafts on-brand posts and articles with a team of AI
agents — text and images — queues everything for **your** approval, publishes
on schedule, and learns from what performs.

> Postiz schedules your content. Pubrick manufactures it.

**Status: pre-alpha.** The skeleton boots; product features are landing
phase by phase — see [docs/specs/0001-product-design.md](docs/specs/0001-product-design.md).

## Why Pubrick

- **Human-in-the-loop by design** — nothing is published without approval
  unless you explicitly enable autopilot. Anti-slop is the point.
- **Brand knowledge** — a per-brand knowledge base (RAG) keeps output on-voice.
- **Bring your own keys** — Gemini and OpenRouter (hundreds of models);
  self-hosted generation at your own API cost.
- **Own it** — AGPL-3.0, docker compose, Postgres as the only stateful service.

## Quickstart (self-hosted)

```bash
git clone https://github.com/pubrick/pubrick && cd pubrick
cp .env.example .env   # edit POSTGRES_PASSWORD at minimum
docker compose up -d
```

Web: http://localhost:3000 · API health: http://localhost:3001/api/health

See [docs/self-hosting.md](docs/self-hosting.md).

## Development

Node 22 + pnpm (corepack) + Docker. `./init.sh` boots the dev stack.
Gates: `pnpm typecheck && pnpm lint && pnpm test` — see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

AGPL-3.0-only.
