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
