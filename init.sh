#!/usr/bin/env bash
# Dev bootstrap: postgres in docker, migrations, then all three apps locally.
set -euo pipefail
cd "$(dirname "$0")"

docker compose up -d postgres
export DATABASE_URL=${DATABASE_URL:-postgres://pubrick:pubrick@localhost:5432/pubrick}
pnpm install
pnpm build
echo "Starting api (:3001), worker, web (:3000). Ctrl-C stops all."
trap 'kill 0' EXIT
(cd apps/api && pnpm start) &
(cd apps/worker && pnpm start) &
(cd apps/web && pnpm exec next dev --port 3000) &
wait
