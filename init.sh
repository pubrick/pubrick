#!/usr/bin/env bash
# Dev bootstrap: postgres in docker, migrations, then all three apps locally.
set -euo pipefail
cd "$(dirname "$0")"

# 127.0.0.1:5432 will collide with a host Postgres if one is already running.
docker compose up -d --wait postgres
# DEV ONLY. These fallbacks exist so `./init.sh` works on a clean checkout with no
# .env; they are published in this repo and must never reach a real install. Compose
# (the self-hosting path) deliberately has no such fallbacks and fails fast instead —
# see .env.example / docs/self-hosting.md.
export DATABASE_URL=${DATABASE_URL:-postgres://pubrick:pubrick@localhost:5432/pubrick}
export BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET:-dev-only-secret-change-me}
export APP_ENCRYPTION_KEY=${APP_ENCRYPTION_KEY:-6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=}
pnpm install
pnpm build
echo "Starting api (:3001), worker, web (:3000). Ctrl-C stops all."
trap 'kill 0' EXIT
(cd apps/api && pnpm start) &
(cd apps/worker && pnpm start) &
(cd apps/web && pnpm exec next dev --port 3000) &
wait
