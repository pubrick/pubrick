# Recurring dispatch guard verification

Date: 2026-10-01. Production integration: `34b65d92`; reviewed UI integration:
`5cfc95ec`. Independent verifier: the integrating agent, separate from the API
and worker implementation author.

Verified production calendar blob: `e48f5c43d6fd339cb959f36f20624aadf0172253`.
Native test blob, including the new null-enqueue regression:
`21054ad9094b86f3ced10b1594f0371d73689bdc`.

## Native environment and scope

An owned, isolated PostgreSQL 16 container used synthetic organizations,
credentials and queues. No worker consumed the generation jobs and no provider
or publication call occurred. The populated migration journal ended at
`1790842335842`, matching migration `0126`.

The full recurring native file initially passed **11/11 in three runs**. A later
full-file boundary mutation failed its intended test in all three runs, but also
failed the unrelated fairness case in the third run. The standard mutation
helper correctly reported **INCONCLUSIVE**; that result is not a pinned guard.
An isolated fairness diagnostic subsequently passed in 10.40 seconds. It does
not establish the cause of the previous failure.

The following proofs therefore isolate the relevant independently seeded tests.
Each phase runs three times with Vitest JSON reports, checks the exact passed and
failed counts, and requires the same sole failing test. Other cases are explicitly
filtered, not reported as tested. No test assertion or timeout was weakened.

```sh
pnpm --filter @pubrick/worker exec vitest run \
  src/calendar/editorial-plan-dispatch.e2e.spec.ts \
  --testNamePattern='exact one-hour boundary|queue returns no job' \
  --reporter=json --outputFile=<owned-report-path>

pnpm --filter @pubrick/worker exec vitest run \
  src/calendar/editorial-plan-dispatch.e2e.spec.ts \
  --testNamePattern='defers 100 quota refusals' \
  --reporter=json --outputFile=<owned-report-path>
```

Supply the owned `TEST_DATABASE_URL`, `DATABASE_URL`, synthetic authentication
and encryption values, and `NODE_OPTIONS=--no-experimental-webstorage`. Never
target a development or production database.

## Results

| Mutation | Clean baseline, each of three runs | Mutant, each of three runs |
| --- | --- | --- |
| Change the dispatch lateness boundary from `>` to `>=` | 2 passed, 9 filtered | 1 passed, 1 failed, 9 filtered |
| Omit the `boss.send() === null` refusal | Same two-case baseline | 1 passed, 1 failed, 9 filtered |
| Omit quota-refusal settlement | 1 passed, 10 filtered | 1 failed, 10 filtered |

The boundary mutation fails only the exact one-hour test: the otherwise valid,
configured, consented occurrence becomes skipped instead of dispatched. The null
mutation fails only the new test: the caller resolves after creating an
irreversible marker without a durable job. That test also checks rollback of the
run and marker and absence of jobs.

The quota mutation fails only the 100+1 fairness case: the healthy occurrence
remains planned on the second bounded scan. Quota refusal is synthetic; plan
identities, locks, transactions and persisted retry values use the real database.
After restoration, the fairness case passed **1/1 in three more runs**.
All production mutations were restored byte for byte. Scoped test lint passed.

## Limits and remaining acceptance

These proofs pin the three selected guards. They do not independently pin every
`canDispatch` predicate, the queue's own implementation, or ordinary-slot quota
fairness. The earlier persistence state-only proof remains separate. API
authority review and the author's native API/worker results are recorded in the
execution plan. The integrated workspace gate and built browser journey remain
required before the feature is reported complete.
