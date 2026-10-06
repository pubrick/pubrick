# Competitive parity: native destinations, team review, results and inbox

Date: 2026-10-07. Plan: [competitive parity](../plans/competitive-parity.md).
This records local acceptance for the combined feature package. It does not
claim live provider acceptance or a hosted deployment.

## Delivered scope

| Area | Implemented behavior | Explicit limit |
| --- | --- | --- |
| WordPress | Public HTTPS site, application password, immutable destination, reviewed title/text, replacement without losing schedules or receipts | Text posts; supported self-hosted REST API; no live owner site used in acceptance |
| LinkedIn | Confidential OAuth through `oauth4webapi`, one-use actor/session/brand state, encrypted generation and expiry, fresh publishing-grant checks and native delivery | Personal accounts and text; configured HTTPS application and actual provider grants required |
| Accepted delivery | Preserve a provider's accepted ID/link when recording is uncertain; reconcile the exact viewed receipt and attempt | Unknown or partial delivery never authorizes an automatic resend |
| Team responsibility | Current eligible assignees, revision guards, assignment history and server-paged Mine/Unassigned/All filters | Assignment does not grant access or approve content |
| Guest review | Mobile review of saved master/channel versions, dirty-composer refusal and exact-version stale recovery | Guest consent applies only to the reviewed saved versions |
| Batch review | At most 20 explicitly selected, loaded posts in one brand; saved master/channel previews and individual acknowledgements; atomic enqueue/refusal | Native immediate delivery only; no hidden-page or future-content consent |
| Results | Scoped publication cohorts, measured coverage, comparison periods, nullable counters and CSV via `csv-stringify` | Actual collectors determine metrics; absent cost/engagement is never reported as zero |
| Inbox | Stable Telegram discussion/message identities, bounded read windows, shared read/resolve revisions, explicit sender proof, durable reply claims and receipts | Public published Telegram text discussions; no direct, protected or media-only messaging; no automatic reply |

Source contracts and setup:
[WordPress](../integrations-wordpress.md),
[LinkedIn](../linkedin.md), [results](../publication-results.md),
[Telegram inbox](../telegram-inbox.md), and
[Meta lifecycle design](../specs/0026-meta-publication-lifecycle.md).
Meta's new public connections and staged delivery are a subsequent implementation
package; the design alone does not enable them in this release.

## Local integration gates

The combined gate on `52ae0d08` passed shared contracts **12**, API **103**,
web **188**, all **20** typecheck tasks and Biome across **1,240 files**.
The API gate includes real Inbox storage/HTTP, export policy and raw LinkedIn
token-expiry validation. A fresh disposable database was removed afterwards.

Earlier integrated native/team/results coverage passed **207 API**, **591
shared** and **1,712 web** cases, schema/upgrade checks, all 20 typecheck tasks
and operational checks. These counts combine complete runs and their focused
fixture repairs, rather than claiming that the first commands passed unchanged.
The integrated batch package added **20 real API** and **173 web** cases,
shared contracts, all 20 typechecks and lint. No aggregate count is given across
these runs because many regressions were intentionally reused.

Inbox's additive migration 0134 passed populated upgrade/journal and schema
checks; independent review found no destructive change or tenant/same-object
foreign-key defect. Native migrations 0131–0133 passed their applicable schema
and upgrade checks. Outbound fixture transports and live database transactions
cover credential generation, archive/deletion, stale decisions and recording
failures. No retained owner database was used as a test database.

## Separate review and corrections

Review identified automatic retries and sleeps inside the installed maintained
Telegram SDK. The discussion sender now selects its maintained no-error-retry
middleware profile; readers keep their existing profile. The sender retains a
stable MTProto `random_id`, and its maintained abort signal is bounded by the
minimum of the request budget, locked session expiry and sender-proof expiry.
This disables SDK retries of internal errors/flood waits; it does not claim
that MTProto never retransmits a packet or handles a data-center migration.

The actual SDK middleware fixture exercises production `replyToDiscussion`
through `sendText`: internal 500, worker-busy 500 and flood-wait each make one
logical RPC call without retry sleep. A reader-profile control makes two calls.
**15** transport cases passed. **22** real API cases passed, including natural
session/proof expiry and simultaneous reuse of one actor operation ID across
different discussions. The losing operation returns coded 409, rolls back its
sender proof and performs no additional create. A final clock/timer refinement
passed its **3** affected deadline cases; API/Telegram types and scoped lint
passed. The fix is integrated at `3a5f4d05`.

Other reviewed corrections include preserving the active workspace during
initial query loading, refusing guest-link creation from an unsaved composer,
validating raw expiry before the OAuth library's numeric coercion, and retaining
accepted receipts without overwriting a newer human resolution. These are
focused regression results, not a whole-project mutation-testing verdict.

## Built desktop and mobile journeys

The runner builds and starts Next.js, compiled API/worker, encrypted credentials,
real Postgres and pg-boss. Outbound delivery uses an owned transport fixture
with an exact request inventory, never the owner's social destinations.

| Clean source | Outcome | Scope |
| --- | --- | --- |
| `f3731087` | Five of six journeys passed; guest journey stopped at an ambiguous alert selector | Composer/calendar, core delivery, WordPress, results/CSV and scoped writes passed |
| `7cca8f89` | Two journeys passed, 36.4 seconds | Guest/team responsibility and mandatory core delivery after the selector correction |
| `3a5f4d05` | Three of four journeys passed, 25.4 seconds | Inbox, WordPress and core delivery passed; batch reached its final close action, where two accessible Close buttons matched |
| `334bf33a` | Two journeys passed, 19.6 seconds | Mobile batch and mandatory core delivery after distinguishing the footer Close action |

This is combined acceptance plus affected repairs, not a claim that one
unchanged full run passed. `--grep` selection always includes the core worker
delivery journey; the runner reports focused acceptance explicitly. The final
selector-only correction passed browser TypeScript and lint.

The batch journey reads both actual saved versions, acknowledges each, changes
one saved version concurrently, observes atomic 409 with neither post queued,
reloads the new text with every acknowledgement reset, closes and verifies both
posts remain draft/pending with zero attempts. The real API suite separately
covers successful atomic batch enqueue and rollback.

The WordPress journey preserves a future reviewed job while rotating its
credentials, refuses a changed destination and checks the full mobile
destination width and 44-pixel actions. The Inbox journey covers discovery,
truthful capabilities, empty states, keyboard filters, mobile settings recovery
and unauthenticated refusal. It does not exercise a complete built MTProto
reply; the send path is covered by SDK and real database/HTTP fixtures.

Screenshots of WordPress, batch and Inbox at 390 pixels were inspected. Channel
actions now wrap below readable details; saved previews and Inbox recovery
actions remain visible without horizontal overflow. Earlier guest-review and
results mobile screenshots were also inspected. The runner removed its owned
processes, media files and disposable database after each terminal run.

## Remaining acceptance prerequisites

- The subsequent Meta connection/media/staged worker package and its local
  acceptance are recorded in [its own evidence report](competitive-parity-meta.md).
  This historical package does not include those connections.
- Real LinkedIn application approval/accounts and WordPress/Telegram test-account
  receipts remain external live-provider acceptance prerequisites.
- Cross-platform metrics and Inbox access require their own actual grants and
  collectors; publication permission alone does not enable either capability.
- Hosted domain/mail/operations and deferred payment acceptance are separate
  launch work. This package does not announce a live paid service.
