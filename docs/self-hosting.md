# Self-hosting Pubrick

## Requirements

- Docker with Compose v2
- 1 GB RAM minimum for the skeleton; Postgres data lives in the `pgdata` volume

## Install

```bash
git clone https://github.com/pubrick/pubrick && cd pubrick
cp .env.example .env    # set POSTGRES_PASSWORD, BETTER_AUTH_SECRET, APP_ENCRYPTION_KEY
docker compose up -d
```

Before exposing the app, set real values for `BETTER_AUTH_SECRET` and
`APP_ENCRYPTION_KEY` in `.env` — compose falls back to weak dev-only defaults
if they're unset. Generate each with:

```bash
openssl rand -base64 32
```

If the app is reachable at a public URL, also set `PUBLIC_ORIGIN` (e.g.
`https://your-domain.example`) so auth cookies and redirects use the right
origin.

Database migrations run automatically when the api container starts.

## Upgrade

```bash
git pull
docker compose up -d --build
```

Migrations apply on boot; back up the `pgdata` volume before major upgrades.

## Configuration

Every variable is documented in [.env.example](../.env.example). Variables
marked optional have safe defaults.
