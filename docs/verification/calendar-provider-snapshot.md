# Calendar provider snapshot verification

Verified locally on 2026-10-01 against base
`01f82f7e2bdfa638689ecd43dd5bc05e3fe571c5` in an isolated worktree.

Calendar admission now uses the maintained `@pubrick/db` selection helpers and
retains `pipeline_runs.text_selection` when enqueueing its generation job. The
snapshot includes provider, resolved model, credential ID, credential revision
and settings revision. The run's input remains the reviewed calendar input.
Selection locks precede a tenant-scoped brand `FOR KEY SHARE`, then the slot lock.
The brand lock prevents the run insert's foreign key from deadlocking with brand
deletion's cascade. No dependencies or database schema changed.

## Native regression evidence

The new `apps/worker/src/calendar/calendar-ai-selection.e2e.spec.ts` runs real
Drizzle transactions, pg-boss enqueueing and `GenerateRepository` claims against
throwaway PostgreSQL. Each case owns a fresh tenant. Credentials are encrypted
synthetic values; credential construction is exercised without model calls.

Before the fix, the eight selection cases produced **6 failures / 2 passes**:
explicit/default/legacy snapshots were null; a key rotated after enqueue was
incorrectly accepted at its new revision; missing selected keys and missing
compatible-provider model IDs incorrectly enqueued work. The separate forced
brand-delete overlap failed with PostgreSQL **40P01** at the calendar run insert.
Both regressions were committed before their implementation fixes.

After the fix, the focused run produced **28 passes across 3 files**:

- Calendar selection: explicit provider/custom model despite an older fallback
  key, unchanged snapshot after settings edits, decrypted selected credential
  construction, built-in default model, legacy oldest-key/default-model
  initialization, rotation/deletion refusal, missing key/model rollback,
  unconfigured workspace behavior, and the real brand cascade overlap.
- Existing calendar suite: scheduling, single transactional enqueue, capacity
  and image reservations, reviewed topic attribution, format validation, and
  tenant/channel checks.
- Existing worker tenant deletion suite: generation, RSS, suggestions,
  Autopilot, publication and publication sweep overlap.

The brand test holds the same initial brand UPDATE lock as self-hosted
`BrandsRepository.delete`, waits until PostgreSQL reports the calendar caller
blocked by that connection, and then performs the real brand DELETE cascade.
It requires both operations to complete without an error and without orphan
runs or generation jobs. This verifies the database lock/FK/cascade interaction;
it does not invoke the API repository's queue cancellation or media cleanup.

Worker TypeScript and Biome checks on both changed TypeScript files passed;
`git diff --check` passed. The full workspace gate and provider HTTP were not
run for this focused slice. Dependency builds used the existing local Turbo
cache. No installed application service, production database or `.env` was used.

## Reproduction

Use a disposable pgvector PostgreSQL instance, then run from the checkout:

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter='@pubrick/worker^...'
TEST_DATABASE_URL=postgres://postgres:calendar-test@127.0.0.1:31462/calendar_test \
APP_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= \
BETTER_AUTH_SECRET=synthetic-calendar-test-secret \
pnpm --filter @pubrick/worker exec vitest run \
  src/calendar/calendar-ai-selection.e2e.spec.ts \
  src/calendar/calendar.e2e.spec.ts \
  src/organization-lock.e2e.spec.ts --reporter=dot
pnpm --filter @pubrick/worker typecheck
pnpm exec biome check apps/worker/src/calendar/calendar.service.ts \
  apps/worker/src/calendar/calendar-ai-selection.e2e.spec.ts
```

The worker's native global setup installs migrations and the pg-boss schema.
Verification used container `pubrick-calendar-provider-snapshot-pg` on dedicated
port 31462; that disposable container was removed after verification.

## Configuration refusal behavior

An entirely unconfigured workspace preserves existing calendar admission:
it queues a null selection and the worker fails the claim as `no_api_key` if it
is still unconfigured. An explicitly selected provider with no matching key,
or a compatible provider without a model, raises the shared selection error
before enqueueing. The transaction rolls back, leaving the slot pending and
creating neither run nor job. `CalendarService.scan` currently rethrows trigger
errors, so that configuration refusal also ends the current scan pass until
settings are corrected. This change does not define a new slot failure status
or scan recovery policy. A retained snapshot never switches providers after
rotation or deletion: the worker records `configuration_changed`.
