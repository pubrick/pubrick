# Weekly editorial plan foundation verification

This is a feature-branch milestone, not recurring-plan release acceptance.
Contracts/calculation and transactional persistence are implemented. Session API,
worker dispatch, calendar UI, combined review and the built user journey remain
pending in [the execution plan](../plans/recurring-editorial-plans.md).

## Source and review

- Contracts/calculator: `1a4c23f3`.
- Persistence: `e1412d68`, equivalent application source to the author's
  `fa977fcc53c19b8203fd34c397e83d01e57e533b`.
- PostgreSQL date boundary correction: `ebe637e0`. Year zero is refused before
  persistence; supported schedule dates are AD years 0001–9999.
- A different reviewer approved migration `0126` before commit: additive upgrade,
  strictly increasing journal timestamp `1790842335842`, matching schema/snapshot,
  referenced uniqueness before composite foreign keys, nullable CHECK semantics
  and UPDATE-only immutability triggers. No reciprocal slot/run foreign keys or
  delete-clearing triggers were added.

Occurrence slot/run UUIDs retain audit attribution after target deletion. Live
targets are checked under tenant/brand scope at dispatch; calendar attribution
uses a one-way composite slot-to-occurrence foreign key. Existing calendar paths
still need integration before they can safely expose recurring work.

## Focused verification

The author ran the exact persistence source on disposable PostgreSQL 16.15,
using `pgvector/pgvector:pg16` at the same image digest as Compose/CI. The database
contained synthetic data only. The command below uses a placeholder rather than
the private local connection string:

```sh
TEST_DATABASE_URL='<disposable synthetic PostgreSQL 16 URL>' \
  pnpm --filter @pubrick/db exec vitest run \
    src/editorial-plan-persistence.e2e.test.ts \
    src/db-tier.guard.test.ts \
    src/editorial-plan-occurrences.test.ts --reporter=dot
```

Result: 3 files, **46 passed**, no skipped tests, 15.61 seconds: 17 native
persistence tests, 21 calculator tests and 8 database-tier guard tests.
Covered populated pre-126 upgrade, serialized plan/occurrence quotas, concurrent
enable and materialization, revision/consent and transactional authorization,
enqueue/slot rollback, pause/edit/resume, manual skip, DST-gap persistence,
cross-scope link refusal, immutable dispatch evidence and measured parent-lock
blocking during brand deletion. The owned container and database were removed.

Additional focused checks passed:

```sh
pnpm --filter @pubrick/db typecheck
pnpm --filter @pubrick/db build
pnpm --filter @pubrick/shared exec vitest run src/dto/editorial-plans.test.ts
pnpm --filter @pubrick/shared build
pnpm --filter @pubrick/shared typecheck
pnpm --filter @pubrick/db exec vitest run src/editorial-plan-occurrences.test.ts
git diff --check
```

After the year-zero correction: **20 DTO tests and 22 calculator tests passed**,
with shared/db typechecks and scoped Biome. The year-zero regression failed on
the prior wire contract before the correction. These affected checks did not
repeat the native suite or the complete workspace gate. Independent persistence
guard mutation proof is a separate verification step; full feature acceptance
must still cover API authorization, queue dispatch and the browser workflow.
