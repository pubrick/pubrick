# Editorial occurrence state guard proof

Verified independently on 2026-10-01 from base
`bdbe74b7e915945e74d065f50163795d7b620d8e` in an isolated checkout.

The existing persistence suite passed all 17 tests on three runs with the
`occurrence.state !== "planned"` dispatch predicate omitted. Its replay fixture
also had a dispatched marker, outdated revision and deleted slot/run, allowing
other predicates to reject it. That result did not prove the state predicate.

The new regression starts with an enabled plan, matching current revision and
consent, a matching live calendar slot and a fresh run owned by the same tenant
and brand. A scoped fixture update changes only the occurrence state to
`suspended`; an equality assertion proves every other occurrence field stayed
unchanged. Dispatch must reject with `not_dispatchable`, preserve the occurrence
and slot linkage, and leave the independently inserted run queued.

Only `occurrence.state !== "planned"` was removed for the mutation. The complete
native persistence file produced the same result on all three runs:

- Mutant: 17 passed, 1 failed; unanimous **KILLED**, solely by the new suspended
  occurrence refusal test.
- Restored implementation: 18 passed, 0 failed; unanimous **SURVIVED**.

The database was recreated between mutant and restored runs. The first run of
each group exercised the populated 0125-to-0126 upgrade fixture. No migration or
production implementation changed in this regression commit.

## Commands and scope

Dependencies were installed offline with the frozen lockfile and shared DTOs
were built locally. Verification used an owned disposable PostgreSQL 16 instance
on port 31482 with synthetic fixture data:

```sh
TEST_DATABASE_URL=postgres://postgres:editorial-review@127.0.0.1:31482/editorial_review \
APP_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
BETTER_AUTH_SECRET=synthetic-editorial-review-secret \
node scripts/mutation-check.mjs @pubrick/db --runs 3 \
  --files src/editorial-plan-persistence.e2e.test.ts
pnpm --filter @pubrick/db typecheck
pnpm exec biome check packages/db/src/editorial-plan-persistence.e2e.test.ts
git diff --check
```

DB TypeScript, focused Biome and whitespace checks passed. The mutation was
restored and the owned PostgreSQL container removed. The full monorepo suite,
provider calls, browser acceptance and CI were outside this focused proof.
