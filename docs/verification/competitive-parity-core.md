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

Integrated source: `fed163bf`; final browser selector correction: `0fc13356`.
Independent checkouts implemented and reviewed the composer, calendar API and
UI before integration. A post-commit restore race found during review was fixed
by returning an atomic restored-body acknowledgement from the locked write.

Implemented behavior:

- Channel tabs retain unsaved edits and support keyboard navigation.
- Saved-body and rich-revision comparisons refuse overwriting a teammate's work.
- Restoring a version retains the acknowledged baseline across later reads;
  a same-text formatting change cannot silently become the editor's baseline.
- Channel previews explain actual text/media limits without promising delivery.
- Scheduled calendar reads are bounded, tenant/brand/filter-scoped and paginated.
- Confirmed moves and swaps update delivery times and jobs atomically; occupied,
  stale, near-due and uncertain deliveries are refused without partial changes.
- Attempt-count and expected-time guards independently catch stale selections.
- Mobile and keyboard controls provide an alternative to dragging, with
  44-pixel dialog and posting-control hit areas.

### Integrated local gates

The final integrated run passed **276 API cases** across content, rich content,
body compare-and-swap and publication calendar suites; **554 shared-contract
cases**; **1,648 web cases**; all **20 typecheck tasks**; and Biome across
**1,158 files**. The API run includes real database rollback, worker-lock wait,
atomic restore and independent stale-time/attempt regressions. It used the owned
loopback PostgreSQL test database, with durability settings enabled.

### Built browser acceptance

`node scripts/e2e/run.mjs` passed from clean source
`0fc13356cbad55a4e93284c54278d232d444ea34`: **three journeys, 44.5 seconds**.
The existing account/delivery and scoped-write journeys passed alongside the new
composer/calendar journey. The latter saved different texts for two channels,
switched tabs using the keyboard, confirmed exact-time swaps on a 390-pixel
screen, checked that the sibling delivery stayed unchanged, refused an entire
stale swap after another editor's move, reloaded and opened the correct channel
version. Confirmation alone created no changes. The first run selected the first
of two identically titled channel cards; its locator was corrected to select the
intended channel without changing production behavior or weakening assertions.

Mobile calendar, confirmation and posting screenshots were inspected for
overflow, readable destinations/times and visible actions. The runner removed
its owned processes, media directory and disposable database. Outbound Telegram
remains a fixture, not a live-provider acceptance claim. The owner's retained
database and other projects were preserved.
