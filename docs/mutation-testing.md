# Proving a guard is pinned

The way this project has argued, for six increments, that a line of code is held
in place by a test: break the line on purpose, run the suite, watch it go red.
That argument is only as good as the suite's determinism. A single run cannot
tell a genuine SURVIVED from a test that merely did not fail this time.

`scripts/mutation-check.mjs` runs a workspace's suite N times and reports a
verdict **only when every run agreed**.

```bash
export TEST_DATABASE_URL=postgres://…       # a database nothing else is writing to
export BETTER_AUTH_SECRET=pubrick-test-secret
export APP_ENCRYPTION_KEY=6DGyBr9BbF2sVZmyO8dQ7HkNq1w4x5z6A7B8C9D0E1E=

node scripts/mutation-check.mjs @pubrick/api --runs 3            # 1. clean tree: expect SURVIVED
#   …apply exactly one mutation by hand…
node scripts/mutation-check.mjs @pubrick/api --runs 3            # 2. mutated tree: expect KILLED
#   …revert it…
```

Narrow it while iterating with `--files src/brands/brands.e2e.spec.ts …`, but
take the recorded verdict from a whole-package run: a mutation is only SURVIVED
if *no* test in the package caught it.

It exits non-zero, and refuses to name a verdict, in four cases:

- **the runs disagree** — the suite answered the same question two ways, so
  neither answer is admissible;
- **KILLED every run, but by a different set of tests** — something other than
  the mutation is moving, so which test pins the line is not established;
- **`TEST_DATABASE_URL` is unset** — the database-backed specs would skip
  themselves and every mutation would read SURVIVED behind a green badge. This
  is the 2026-08-24 failure in `docs/lessons.md`, in the one place where it
  would be silent;
- **`--runs 1`** — one run is not a measurement.

## What a unanimous verdict does and does not prove

It proves the outcome was **reproducible over N runs, on that machine, under
that load**. It is a statement about repeatability, not a proof of determinism:
a flake rarer than roughly 1-in-N still reads as unanimous. Raising `--runs`
lowers that ceiling and never removes it.

It says nothing at all about mutations you did not write. A SURVIVED verdict
means *this* edit went uncaught; it does not mean the line is untested, and it
does not license deleting the line — see the `.for("update")` in
`ContentRepository.requireHumanInvolvement`, kept deliberately with the
measurement written next to it.

Verdicts are not portable across environments. Run the whole comparison —
baseline and mutation — on the same machine, in one sitting, and re-run the
baseline if anything about the machine changed underneath it.

## Keep the runs independent

The suites share one database and never truncate it, so a mutation run's residue
outlives it. That is deliberate — every e2e file scopes its assertions to orgs
and ids it created — but it means the tests must earn their isolation rather
than inherit it:

- **Scope by identity, not by shape.** A count, or a "some row exists" probe, is
  a claim about the whole table and will eventually be answered by another run's
  leftovers. `PublishRepository.sweepAbandoned` sweeps globally by design; its
  tests survive that only because each asserts about the one adaptation it
  seeded.
- **Statement text does not identify a connection.** `brands.e2e.spec.ts` and
  `channels.e2e.spec.ts` both wait for a lock waiter in `pg_stat_activity`, both
  cascade through `adaptations`, and both reach it as a byte-identical
  `select "id", "status", "attempt_count" from "adaptations" where …`. They are
  told apart by `application_name`, set per file in the connection string.
- **Prefer an observed condition to a sleep.** `waitForLockWaiter` and
  `waitForJobState` poll until the thing has actually happened and fail loudly on
  a deadline. Two sweep tests still bracket a race with a fixed 500 ms sleep
  (`publish.e2e.spec.ts`, `generate.e2e.spec.ts`, "loses the race …"); their
  final assertion, after the commit, is the load-bearing one, and the mid-race
  assertion is the part a slow machine could make vacuous.

If you add a database-backed test, assume another copy of the suite is running
beside yours, and that yesterday's rows are still there.
