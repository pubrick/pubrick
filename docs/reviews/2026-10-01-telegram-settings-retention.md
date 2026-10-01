# Telegram settings, retention and actor primitives

Scope: follow-up to the [setup/binding backend](2026-10-01-telegram-setup-binding.md).
This milestone provides account-connection controls and bounded background
retention. Draft callbacks still do not issue confirmations or reject content.
The complete decision workflow and compiled browser acceptance remain open.

## Settings

Settings → Notifications exposes each member's own two-phase Telegram account
connection. Managers additionally see bot setup/disable, existing credentials,
history and digest controls. The existing Notifications navigation row is
available to members without expanding API-key, webhook or billing access.
Connection and bot controls show current state, explicit uncertainty, refresh,
expiry and confirmation dialogs. All four locales use the shared UI controls.

Workspace changes remount connection controls, clear secret/chat drafts and
scoped configuration, and ignore late loads, saves, tests and digest responses.
Focused web tests cover account consent, expiry, unlink, setup revision/uncertainty,
member access without manager requests, and stale saves across workspace switches.
The controls explicitly say draft decisions are not yet available.

## Bounded background retention

A worker lifecycle runs immediately and then every ten seconds, prevents
local overlap, reports generic failures, and drains its admitted batch on shutdown.
Each tick selects at most 20 eligible organizations. A cyclic organization
cursor advances despite failed batches; parent locking skips unavailable tenants
before the limit. Correlated EXISTS checks avoid hiding other tenants behind one
large backlog. Each transaction uses statement and lock deadlines.

Each organization's sweep locks its parent first, discovers at most 100 overdue
rows per tier without child locks, then locks referenced registry rows in canonical
`length(bot_id), bot_id` order. It chooses the earliest retention deadline before
that bound and acquires selected child locks by stable ID. It removes challenge
metadata after 24 hours and initial/final capability or replay rows after seven
days. Bindings, opaque audit and physical remote-attempt evidence remain intact.
No remote claim is released by elapsed time. Bounds and progress describe a
running worker, not a guarantee while it is stopped or the database is unavailable.

Independent review found and closed two progress defects: locked/failing first
organizations could starve later tenants, and UUID preselection could leave the
oldest personal rows behind newer overdue rows. Native closure checks cover
21 tenants, 20 locked parents, a 2,001-row backlog, cyclic progress without prior
deletion, and an oldest high-UUID record among 101 overdue records.

## Future callback primitives

A strict callback parser rejects unsafe numeric IDs, inline/inaccessible messages,
other-bot messages and invalid private chat provenance. Unknown actions stay inert.
It is not wired into webhook admission in this milestone.

A transaction-taking bound-actor helper locks organization → user → brand →
member/grants → registry/config/binding, using current unioned editorial roles,
brand grants and hosted verification. It grants no synthetic session authority.
Native `pg_blocking_pids` checks show role revocation and unlink wait for the
current authorized transaction, and the next authorization is refused. The future
owning transaction must still prove the route, capability, complete snapshot,
unsent eligibility and one-shot mutation/replay/audit.

## Verification and limits

- Worker retention: nine initial cases passed; four affected closure cases passed
  after fairness changes. This covers 12 distinct cases, including real database
  lifecycle execution and raw user/organization deletion overlap. Preserve both
  logs; this is composite coverage, not a new complete all-green worker suite.
- Web connection settings: 15 focused cases passed across two files.
  The changed main settings navigation has composite coverage of 77 cases:
  76 passed initially, then two selected cases passed after updating the old
  author-only navigation expectation to permit own-account Notifications.
  Node 26's native Web Storage shadowed jsdom in the first attempt; the closure
  used its documented `--no-experimental-webstorage` flag. A malformed intermediate
  test edit also failed before the corrected selected closure. All logs remain.
- Bound actor: four native cases passed; callback parser: five cases passed.
- Integrated workspace typecheck: 20 tasks passed; lint: 1,104 files passed.
  The initial typecheck found a test fixture's inferred UUID template type;
  its parameter now correctly accepts an opaque organization string.
- API, worker and web production builds passed.

No live Telegram, model, publication or payment call occurred. The real browser
journey against built services has not run for these controls. Full atomic draft
rejection, stale snapshot, domain deletion, janitor/decision/revocation races,
unknown-send reconciliation and browser/API/worker acceptance remain required.
Local initial and closure logs are retained under
`/Users/admin/.codex/backups/pubrick-validation-20261001/`.
