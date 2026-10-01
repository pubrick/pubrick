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
not used.

## Independent and integrated checks

A separate reviewer ran the new native selection file on owned PostgreSQL
(port 31482): baseline 11/11 on each of three runs. Omitting only the stored
snapshot yielded seven consistent failures per run; omitting only brand KEY
SHARE yielded the single forced brand-cascade failure; disabling only the
configuration-refusal catch yielded the single two-tenant progress failure.
Each mutation was killed unanimously over three runs and restored afterward.
The transient-error assertion stayed green during the refusal-catch mutation.
No further actionable review finding remained.

The integrated local milestone command passed:

```sh
pnpm typecheck
pnpm lint
pnpm test --continue=always --concurrency=2
```

Typecheck: 20/20 tasks, 18 reused caches, 19.539 seconds. Biome: 1,016 files,
no fixes. Tests: 20/20 tasks, eight reused caches, 2m45.009s; 3,508 package tests
passed. This ordinary command skipped database opt-in tiers (120 db, 380 worker
and 844 API tests); the focused native/independent results above are separate
applicable proof. It is not a claim of a fresh full native suite.
The API/MCP release also passed its own complete CI run on
`81b346fbdd299cd5c880dca2f9d70478db7842bf` before main integration.

Owned author/root/reviewer PostgreSQL containers were removed; no real provider
or publication call was made. The calendar fixes remain a feature milestone
until their own main integration, separate from the approved API/MCP release.
