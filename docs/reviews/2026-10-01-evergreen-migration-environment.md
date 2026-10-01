# Evergreen historical migration verification

Date: 2026-10-01. Code candidate: `06203f6a`, containing the private fixture
optimization `7abd5741`. Tracking: `Ozon-tools-se7md`.

## Verified scope

All 57 cases in `packages/db/src/migrate.test.ts` passed in 84.57 seconds.
The historical matrix checked every one of the journal's 127 cutpoints,
including the empty starting database, in 47.685 seconds. The existing
30-second case limit and 480-second matrix limit were unchanged. No historical
version, assertion, or production migration was removed or altered. The matrix
asserts the exact timestamp-with-time-zone column inventory after each upgrade;
it does not assert arbitrary full schema or data equivalence.

The previous macOS Node 26 execution completed with 44 passes and 13 timeouts;
the fixture optimization alone did not resolve that run. The successful run
changed the execution environment to Linux Node 22 and colocated the client
with PostgreSQL's container network namespace. This comparison does not isolate
Node version, host forwarding, filesystem, or shared-host load as the sole cause.
It does not prove a product deadlock or that the fixture optimization alone
caused the improvement.

## Reproduction and isolation

- Source: tracked-only `git archive` of `06203f6a`, with no local `.env`,
  credentials, or host `node_modules` included.
- Runtime: Node 22.23.3, pnpm 10.34.5, frozen lockfile; image
  `node@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c`.
- Database: PostgreSQL 16.15 aarch64 with the repository's pinned pgvector image,
  disposable data on a 768 MiB tmpfs.
- Client: separate owned container sharing the database container's network
  namespace, connecting to `127.0.0.1:5432`. Its temporary directory used a
  separate 256 MiB tmpfs. Existing user applications were not stopped.

After installing the database dependency closure and building shared:

```sh
TEST_DATABASE_URL=postgres://test:test@127.0.0.1:5432/pubrick_evergreen_test \
DATABASE_URL=postgres://test:test@127.0.0.1:5432/pubrick_evergreen_test \
pnpm --filter @pubrick/db exec vitest run src/migrate.test.ts \
  --maxWorkers=1 --reporter=verbose
```

## Fixture change and limits

The private prefix helper uses Node's maintained `fs.cp` filter to copy only
the selected SQL files and journal. It omits Drizzle Kit schema snapshots that
the installed runtime migrator does not read. Prior independent review checked
that runtime and the helper's callers; direct prefix inspection checked exact
journal/SQL bytes at empty, intermediate, and latest cutpoints. The successful
native run exercises every historical prefix using the optimized helper.

The remaining 29 database files were then run separately, excluding the already
passed migration file: all 206 cases passed in 52.22 seconds. Together these
executions cover all 263 database cases, without counting duplicate cases.

## Separate Google proxy fixture closure

The next serialized package gate passed mail (23 cases) and reported AI as
433 passes and one failure. The unchanged proxy test reproduced independently
with nine passes and one failure. A minimal same-runtime server/fetch diagnostic
showed `localhost` binding `::1` while fetch attempted `127.0.0.1`, causing
`ECONNREFUSED` before a proxy handshake.

The affected test now binds an explicit IPv4 loopback and uses that same address
in its synthetic proxy URL and expected CONNECT Host. Production transport is
unchanged. The real CONNECT socket, upstream target, exact Basic authentication,
response body, and proxy-specific Host assertions remain. All ten affected cases
passed; scoped lint and independent affected review passed. This is composite
AI acceptance (433 unaffected passes plus the corrected case), not a fresh
whole-AI rerun or a live Google connection test.

This receipt closes the historical migration and proxy fixture investigations
for this Linux configuration. Other workspace packages, browser workflow,
release images, and hosted payment setup remain separate acceptance evidence.
