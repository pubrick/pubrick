# Workspace export entry error handling

Date: 2026-10-01. Tracking: `Ozon-tools-joedr`.

The evergreen integration gate exposed two fixture configuration errors:
the billing database name did not match the disposable-database safety rule,
and its 256 MiB temporary filesystem could not satisfy export's required
256 MiB free-space headroom. The failed API run is not a passing gate:
1,256 cases passed, five failed, and 11 billing cases skipped after setup failed.
Correcting the owned database name and using a 1 GiB temporary filesystem made
all 23 cases in the three affected files pass, without changing either guard.

Independent review also identified a genuine production error path. When
staging fails while a large tar entry is pending, tar-stream destroys that
entry's writable stream. Its callback rejects, and the stream separately emits
an error. The existing helper observed only the callback; the outer pipeline
does not observe the nested entry stream. This could produce an uncaught
exception in addition to the expected HTTP refusal.

## Fix and regression

The helper now observes the returned entry stream's error event through the
existing tar-stream interface. Callback rejection and deferred stream errors
settle the same promise; original pipeline HTTP exceptions still reach callers.

The service-level regression uses real tar, gzip, staging, and file streams,
with only the free-space measurement replaced by zero. Its large NDJSON input
exercises a pending entry. It requires the original low-space refusal, no
download, removal of staging artifacts, and no uncaught error.

- **Original source, new regression:** seven assertion cases passed, but Vitest
  reported one uncaught 503 from the regression and exited unsuccessfully.
- **Fixed source:** 16 cases across service, native PostgreSQL export, and staging
  files passed in 11.98 seconds, with no unhandled errors.
- API typecheck and scoped two-file Biome passed.
- Independent source, original-source reproduction, and final result review passed.

```sh
pnpm --filter @pubrick/api exec vitest run \
  src/workspace-data/export.service.spec.ts \
  src/workspace-data/export.e2e.spec.ts \
  src/workspace-data/export-staging.spec.ts \
  --maxWorkers=1 --reporter=verbose
```

The native tier used the pinned Linux Node 22 / PostgreSQL environment described
in the [migration record](2026-10-01-evergreen-migration-environment.md), with
a 1 GiB temporary filesystem. The specific reproduction proves low-space
handling during a pending entry. Broader size, write, and cancellation errors
use the same stream path; this record does not claim separate fault-injection
proofs for all of them or a fresh passing whole-API run.
