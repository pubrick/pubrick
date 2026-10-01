# Browser source and database receipts

Date: 2026-10-01. Code candidate:
`c23f1e252349b24f4f4e915c85e6e200de93657b`.
Tracking: `Ozon-tools-dy2ed`. Main release pending.

All four local browser runners now share `browser-provenance.mjs`. They use
the exact reviewed PostgreSQL image digest in CI, require a valid clean Git
commit before allocating temporary resources, and recheck that same commit
and clean working tree before printing success. Tracked modifications and
nonignored untracked source are refused. Ignored build outputs remain allowed.
The success receipt names the source commit and database image digest.

This closes two observed acceptance weaknesses: a Git/developer-tools failure
could previously print an empty source revision, and a mutable `pg16` tag could
silently change the database used by a later run. Source integrity is checked
at start and finish; this is not cryptographic attestation of ignored artifacts
or proof that no transient edit was made and restored during execution.

## Verification

- Three new regression cases pass: a real disposable Git repository exercises
  missing/unborn HEAD, clean identity, tracked/untracked changes and a changed
  commit; all four runners reject Git exit69 before builds, Docker or temporary
  allocation; their configured database digest matches CI.
- Root scripts: 53 passed, three explicitly opt-in checks skipped. Browser
  TypeScript and six-file Biome passed.
- Independent source review passed without findings.
- The compiled evergreen journey was rerun against the pinned image at the
  recorded candidate: one scenario passed in 7.5 seconds after readiness. Its
  checked receipt contains the exact source above, the configured database
  digest and five scripted calls. Owned stack cleanup completed successfully.

```sh
node --test scripts/*.test.mjs
pnpm exec tsc --noEmit -p scripts/e2e
node scripts/e2e/evergreen.run.mjs
```

The current change does not rerun the hosted, recurring or general self-hosted
journeys: their shared source preflight and configuration are covered by the
regressions, while the actual compiled integration was exercised by evergreen.
No app, database migration, production provider or payment path changed.
Local raw logs are retained as `browser-provenance-scripts.log` and
`browser-provenance-built-journey.log` under the private validation backup
directory described in the [evergreen integration record](2026-10-01-evergreen-integration.md).
