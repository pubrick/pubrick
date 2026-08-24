# CLAUDE.md

Pubrick — open-source AI content factory (AGPL-3.0). TypeScript monorepo:
pnpm + Turborepo. Everything — code, comments, commits, docs — is in English.

## Commands

- Install: `pnpm install`
- Build all: `pnpm build` (turbo; packages build before apps)
- Typecheck: `pnpm typecheck`
- Lint/format: `pnpm lint` / `pnpm format` (Biome; formatting is hook-enforced, don't hand-format)
- Test all: `pnpm test`; single package: `pnpm --filter @pubrick/db test`;
  single file: `pnpm --filter @pubrick/db exec vitest run src/migrate.test.ts --reporter=dot`
- DB integration tests need `TEST_DATABASE_URL` (see docker compose); they skip when it is unset.
- Dev stack: `./init.sh` (starts postgres via docker, runs migrations, boots web+api+worker)

## Architecture

- `apps/web` — Next.js UI only (next-intl, EN source of truth + es/ru/pt).
- `apps/api` — NestJS: one module per domain; runs DB migrations on boot; OpenAPI.
- `apps/worker` — NestJS standalone context: pg-boss consumers (jobs, cron). No HTTP.
- `packages/db` — Drizzle schema + SQL migrations (applied programmatically; never edit applied migrations).
- `packages/shared` — zod schemas, env parsing, types. No runtime deps beyond zod.
- Queue is pg-boss on Postgres. There is NO Redis; do not add one.

## Conventions

- TS strict; no `any` without a comment explaining why.
- Every tenant-owned table will carry `org_id NOT NULL`; all DB access goes
  through package-level repositories (never inline SQL in controllers).
- Enqueue jobs in the same transaction as the domain write.
- Conventional commits. One logical change per commit.
- TypeScript stays on the 5.x line workspace-wide until tsup/NestJS fully support 7.x; one compiler version for the whole monorepo — never pin a different major in an individual package.

## Verifying your work

Before reporting any task complete: run `pnpm typecheck && pnpm lint && pnpm test`
and paste the tail of the output. Failing tests are reported as failing —
never edit or delete a failing test to make it pass (see CONTRIBUTING.md
bug-fix protocol).

## Things Claude gets wrong

(grown from repeated mistakes — add an entry when a correction happens twice)

## Compact instructions

When compacting, always preserve: the list of modified files, the task being
executed and its remaining steps, and the exact test commands being used.
