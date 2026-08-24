# Self-hosting Pubrick

## Requirements

- Docker with Compose v2
- 1 GB RAM minimum for the skeleton; Postgres data lives in the `pgdata` volume

## Install

```bash
git clone https://github.com/pubrick/pubrick && cd pubrick
cp .env.example .env    # set POSTGRES_PASSWORD
docker compose up -d
```

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
