# Calendar configuration refusal isolation

Independent review of calendar provider pinning found that a missing explicitly
selected key/model raised `AiTextSelectionChangedError` from admission and
aborted the global due-slot scan. The earliest bad slot remained eligible,
repeatedly preventing later workspaces from reaching generation admission.

Native red reproduced the actual refusal with a missing selected OpenRouter key
and a second tenant's due slot: 1 failed, 10 filtered, 7.33 seconds. The test
requires the real global scanner, real transaction and pg-boss enqueue, with
synthetic credentials and no provider call.

The scanner now catches only that shared error class after admission rollback,
defers the still-pending tenant-scoped slot by five minutes and continues. It
logs a closed configuration reason. Transient database/queue failures still
propagate; a deferral database failure also propagates. Changed/deleted slots
cannot acquire a run or lose their terminal error through this update.

Affected native green: 30/30 across calendar selection, existing calendar and
organization deletion specifications, 5.52 seconds. The new regression checks
no run/job for the invalid tenant, bounded future `retryAfter`, exactly one job
for the healthy tenant, and exclusion of the deferred slot on the next scan.
A separate test requires transient dispatch error propagation and no fabricated
deferral. Worker typecheck and focused Biome checks passed.

Calendar exposes its existing retry time; this change does not add a new visible
configuration error code. Operators repair the selected provider/model in
Settings; the next eligible scan retries. No new schema or credential fallback
is introduced. Unconfigured legacy admission and all human publication gates
retain their existing behavior.

Verification used owned disposable PostgreSQL on port 31492 and the built
workspace packages. The installed services, real `.env` and vendor APIs were
not used. An independent mutation review and the integrated milestone gate
remain separate evidence, not implied by these focused checks.
