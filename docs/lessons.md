# Lessons log

Append-only. When something bites us (agent or human), record it here:
date, what happened, root cause, rule to prevent it. Recurring entries get
promoted into CLAUDE.md ("Things Claude gets wrong") or a skill.

## 2026-08-24 — turbo strict env mode silently strips undeclared env vars

Turborepo's strict env mode only passes through env vars a task explicitly
declares in `turbo.json`. The `test` task didn't declare `TEST_DATABASE_URL`,
so turbo stripped it before the db package's tests ran — the integration
test's `TEST_DATABASE_URL` guard read as unset and the test skipped itself.
CI stayed green the whole time because a skipped test still exits 0.
Root cause: any env-gated test whose variable isn't declared in the task's
`env` list will silently skip under turbo, with no warning. Rule: any new
env-gated test must declare its variable in `turbo.json`'s `test.env`.

## 2026-08-24 — biome's `useImportType` safe fix breaks NestJS constructor DI

`pnpm format` (`biome check --write`) rewrote a plain `import { BrandsRepository }`
into `import type { BrandsRepository }` in a Nest controller; with
`emitDecoratorMetadata: true` that elides the runtime value, so Nest's
`design:paramtypes` reflection has nothing to inject and app bootstrap fails
("Nest can't resolve dependencies..."). Rule disabled via `biome.json`
`overrides` scoped to `apps/api/src/**/*.ts` and `apps/worker/src/**/*.ts`
(the two Nest apps with `emitDecoratorMetadata` on) — never let biome
auto-fix touch import styles in those trees.

## 2026-08-24 — integration suites must be verified against a FRESH database

`pnpm test` was green locally and red on CI for anyone starting from an empty
volume: four api e2e specs run in separate vitest workers and each calls
`runMigrations()`, so on a database with nothing applied yet they raced on
`CREATE EXTENSION vector` / `CREATE SCHEMA drizzle` / the migrations table and
died with `duplicate key value violates unique constraint
"pg_extension_name_index"`. On a warm database every migration is a no-op, so
the race has no window and the suite passes — which is exactly why every
per-task verification during the plan missed it. Root cause: concurrent
migrators with no mutual exclusion (the same hazard as two api replicas booting
together in production). Fixed at the root with `pg_advisory_lock` around
`migrate()` in `packages/db/src/migrate.ts`. Rules: (1) any migration runner
must hold an advisory lock; (2) verify integration suites against a database
created moments ago, not the one left over from the last run — "it passed
locally" is not evidence until the DB was fresh.
