#!/usr/bin/env bash
# Dev bootstrap: postgres in docker, migrations, then all three apps locally.
set -euo pipefail
cd "$(dirname "$0")"

# This script used to `export BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET:-dev-only-secret-change-me}`
# and a matching APP_ENCRYPTION_KEY. Those values are published in this repository, so
# they are not secrets: anything they protected could be forged or decrypted by anyone
# holding the source. Compose refused them; running the apps straight from this script —
# which is exactly what this script does — did not. It now generates a real pair once,
# into the .env compose already reads (and .gitignore already excludes), so both paths
# agree on one value. The api refuses to boot on a published one in production; every
# literal below is on that refusal list (apps/api/src/auth-policy.ts).
command -v openssl >/dev/null || { echo "openssl is required to generate secrets" >&2; exit 1; }
[ -f .env ] || : > .env
ensure_env() { # name, value — writes only if the name is not already present
  grep -qE "^${1}=" .env || printf '%s=%s\n' "$1" "$2" >> .env
}
# APP_ENCRYPTION_KEY must be STABLE across runs: it decrypts channel credentials at
# rest, so a value regenerated on every start would orphan everything already stored.
# That is why these are persisted rather than exported per invocation.
ensure_env BETTER_AUTH_SECRET "$(openssl rand -base64 32)"
ensure_env APP_ENCRYPTION_KEY "$(openssl rand -base64 32)"
# Compose requires this one; a local dev run reaches the web app on :3000.
ensure_env PUBLIC_ORIGIN "http://localhost:3000"
set -a
# shellcheck disable=SC1091
. ./.env
set +a

# A .env copied from .env.example keeps its placeholders, and ensure_env leaves an
# existing name alone. Refuse rather than run on one.
for name in BETTER_AUTH_SECRET APP_ENCRYPTION_KEY; do
  case "${!name}" in
    REPLACE_ME_RUN_openssl_rand_base64_32 | dev-only-secret-change-me)
      echo "$name in .env is still a placeholder published in this repository." >&2
      echo "Replace it with a fresh value: openssl rand -base64 32" >&2
      exit 1
      ;;
  esac
done

# 127.0.0.1:5432 will collide with a host Postgres if one is already running.
docker compose up -d --wait postgres
# Built from the same POSTGRES_* the compose file uses, so a .env with a real password
# does not leave this script talking to a database that does not exist.
export DATABASE_URL=${DATABASE_URL:-postgres://${POSTGRES_USER:-pubrick}:${POSTGRES_PASSWORD:-pubrick}@localhost:5432/${POSTGRES_DB:-pubrick}}
pnpm install
pnpm build
echo "Starting api (:3001), worker, web (:3000). Ctrl-C stops all."
trap 'kill 0' EXIT
(cd apps/api && pnpm start) &
(cd apps/worker && pnpm start) &
(cd apps/web && pnpm exec next dev --port 3000) &
wait
