# Competitive parity: core workflow verification

Date: 2026-10-06. Plan: [competitive parity](../plans/competitive-parity.md).
This records verified feature-branch behavior. Main release is the combined
milestone 1 and milestone 2 package; this receipt alone does not announce it.

## Milestone 1 — review and posting queue

Implementation: `8e15a654`, `cf80698e`; focused gate repairs and browser
selectors: `9c1d8823`, `dd8c79b7`, `367645ef`, `74cd32fe`, `773bb9a6`.
The repairs retain production guards: the database fixture explicitly accepts
only the safe inactive posting defaults, and the tenancy inventory names the
existing cross-workspace singleton regression.

Implemented behavior:

- Review queue navigation, readable delivery times, loading and refusal recovery.
- Per-channel weekly times in an IANA zone; bounded next-slot preview creates no jobs.
- Explicit confirmation preserves the exact previewed times and saved-content fingerprint.
- Unsaved master, channel or inline-image changes prevent browser approval.
- Immediate and timed browser approvals also carry the saved review fingerprint.
- Scheduled deliveries have chronological server-side pagination.
- Scheduling admission uses one organization publication lock before adaptation locks.

### Local gates

Typecheck passed all 20 tasks. Biome passed, including the touched repair files.
The relevant complete local package coverage totals **5,302 passing cases**:

| Package or gate | Passing cases |
| --- | ---: |
| Operational Node checks | 81 |
| Shared contracts | 542 |
| Database | 288 |
| API | 1,343 |
| Worker | 665 |
| Web | 1,621 |
| AI | 434 |
| Integrations | 144 |
| Mail | 23 |
| Billing unit contracts | 88 |
| Telegram | 32 |
| Search | 9 |
| MCP | 32 |

This is combined evidence from the complete package runs and affected repairs,
not a claim that the first full command passed unchanged. A historical fixture
assertion, disposable-database naming and the new singleton inventory initially
failed; only their affected checks were repeated. Eleven API billing-storage
cases were excluded because their separate disposable billing tier was not
configured. Payments remain deferred. Database tests used owned loopback
PostgreSQL 16 with pgvector, `fsync=on` and `synchronous_commit=on`.

### Separate guard review

An independent checkout reviewed the implementation and migration. In a fresh
disposable database, the focused nine-case API baseline passed three times.
Removing only the approval review-fingerprint check caused the same three
immediate/timed/relative approval regressions to fail three times (HTTP 200
instead of 409). Restoring it and removing only confirmation's saved-content
fingerprint comparison caused the same confirmation regression to fail three
times. The other baseline cases remained green. Both files were restored
byte-for-byte and the review database was removed.

These are targeted causal regression checks. They are not a whole-package
mutation-testing verdict.

### Built browser acceptance

`node scripts/e2e/run.mjs` passed from clean source
`773bb9a6a939daac04d0e19686a0561b7671563b`: **two journeys, 24.7 seconds**.
The runner built and ran Next.js, the compiled API and worker, encrypted channel
credentials, real Postgres and pg-boss. Only the outbound Telegram boundary was
an owned fixture; this is not live Telegram acceptance.

The journeys covered account/workspace creation, manual preparation, native
connection testing, saved-content review, configured weekly time, unsaved
approval refusal, a teammate change after preview, fresh review/recovery, exact
persisted scheduled time, chronological upcoming display, actual worker delivery
and persisted receipt, workspace switching, export, scoped imported content and
key revocation. Desktop and 390-pixel layouts were exercised; both posting-time
and confirmation screenshots were inspected for overflow and visible actions.
The first runs exposed selector mistakes (nested label text, tab roles and the
route announcer); these were corrected without weakening behavioral assertions.

Owned browser processes and database were removed by the runner. The gate
database was also removed. The owner's retained Pubrick database volume and
other active Docker projects were preserved. Mobile inspection additionally
identified small dialog/control hit areas; their 44-pixel correction is part
of the milestone 2 package and awaits its final built acceptance.

## Milestone 2 — composer and publication calendar

Implementation and verification are in progress in independent checkouts.
This section will record retained edits, saved-body compare-and-swap behavior,
scoped calendar reads, atomic moves and the combined desktop/mobile journey
after their integrated checks finish.
