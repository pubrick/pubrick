# Comprehensive review — 2026-09-30

Baseline: `1cc1a59af8d571402bbdba540c34dd970c7cef07` (`main`).

The review covered the production code across Pubrick's API, web application,
worker, MCP server, shared contracts, database layer, and integrations. Three
independent reviewers inspected separate checkouts. Confirmed defects were
reproduced with regression tests before their fixes. This is a broad code and
local integration review, not a certification that every possible execution
path is correct.

## Confirmed findings

All findings below are fixed in the accompanying branch. P2 means a functional
failure under the described conditions; P3 means a smaller usability defect.

| Priority | Area | Failure and triggering condition | Resolution and regression coverage |
| --- | --- | --- | --- |
| P2 | MCP content client | One archived item made list/detail response validation fail; archived filtering was unavailable. | Derive statuses from the shared lifecycle; archived list, detail, and filter tests. |
| P2 | Notifications, topic history, news reranking | PostgreSQL timestamps with microseconds were truncated through JavaScript `Date`; subsequent pages silently skipped rows at the boundary. | Keep cursor timestamps as database-generated UTC text with full precision; three real PostgreSQL boundary tests. |
| P2 | Native development bootstrap | Custom database/web ports and `PUBLIC_ORIGIN` were ignored, producing connection and sign-in failures. | Honor configured ports; export matching auth/web/proxy origins; run the script against command stubs with nondefault ports. |
| P2 | Organization roles | Better Auth's comma-separated role arrays were treated as unknown single roles. Composed managers lost management access and editorial users could not receive brand grants. | Shared role-union helper across API, SQL guards, and web affordances; HTTP tests include author restrictions, editor capability, and composed managers. |
| P2 | Generation retry | Retrying a failed brief/source run dropped the user's requested headline. | Preserve stored title; both input modes tested. |
| P2 | Autopilot manual checks | A queued/retrying/active job older than ten minutes was marked failed despite still being live. | API and worker reconciliation only fail orphaned checks; live queue-state tests. |
| P2 | Autopilot topic generation | Approved topic format, SEO keywords, and source URL were discarded. | Preserve settings and validate the constructed shared RunInput; expert article/source regressions. |
| P2 | Yandex search evidence | Mixed XML text and highlight elements changed word order, potentially changing a claim's meaning. | Use fast-xml-parser's ordered representation; inline and repeated highlight evidence tests. |
| P2 | Knowledge embedding metering | A failed usage-ledger write escaped optional knowledge lookup and aborted generation without accounting for the unrecorded call. | Record the lost usage call and continue generation; successful and rejected embedding scenarios. |
| P2 | Modal forms | An inline close callback caused the focus effect to run on each render, interrupting typing. | Keep the latest callback in a ref and bind focus lifecycle to opening; controlled-input typing regression. |
| P2 | Poll refresh | A superseded terminal response or an old refusal after local mutation could stop polling before the newer state was checked. | Ignore superseded requests and errors from older mutation generations; deferred-response regressions. |
| P2 | Analytics | A late response for the previous period overwrote the currently selected period. | Sequence loads and discard obsolete responses; deferred period-change regression. |
| P2 | AI settings | A verdict for an old key/proxy, or a late initial credential load, overwrote current saved state. | Revision guards around tests and loads; replacement and deferred-load regressions. |
| P2 | Editor saves | Two overlapping master/adaptation writes could finish in reverse order and lose newer text. A late rich-text response could replace a newer draft. | Serialize each save stream and preserve edits made during requests; deferred double-save regressions. |
| P2 | Brand settings permissions | Legacy members saw profile/voice/link edit actions whose API requires a manager; Save failed with 403. | Match manager-only affordances while retaining member channel/feed controls; role-specific UI regression. |
| P3 | Memorable dates | Reopening Manage after cancelling Edit left old values in an Add form, encouraging an unintended duplicate. | Reset the new-entry form when reopening; cancel/reopen regression. |
| P2 | Tenant deletion lock order | An API or worker mutation locked a child before a later organization FK lock; owner deletion locked the organization before cascading to the child, producing PostgreSQL `40P01`. | Acquire the tenant before affected child writes, without lock upgrades; real concurrent deletion tests for notes, knowledge import, brand grants, generation, Autopilot, RSS, suggestions, publication completion, and recovery. Bulk sweeps lock candidate tenants in a consistent order and restrict writes to that set. |
| P3 | New-post channel guidance | A selected brand with no channels only showed a refusal, without a route to the required setup step. | Add a localized link to that brand's channel setup; empty-state regression. |

## Documented usability improvement

Client review links previously exposed the cover and written draft while
explicitly leaving inline illustration review to the editor. This was an
existing documented limitation, not a newly discovered regression. Guest review
now shows inline images, captions, alt text, and alignment through token-scoped
routes. Every image request revalidates the capability, current snapshot, slot,
organization, brand, and image asset. Private media IDs are not returned. Existing
snapshot hashes retain their shape. Capability, stale/revoked link, and guest
rendering tests cover the change.

## Scope and remaining limits

- API: authentication/invitations, tenant and brand authorization, public API,
  credentials/proxy, source extraction, private Telegram, media, feeds, guest
  review, knowledge, calendar/topics/runs, notifications, and prompt boundaries.
- Web: auth/onboarding, shell/UI, polling/editor/provenance/media, settings,
  brands/channels/access/import, calendar, knowledge/topics/sources, autopilot,
  publications, analytics, and guest review.
- Worker: queue/fences, autopilot/calendar/topic planning, knowledge/RSS/relevance,
  comments/paid analysis, notification outbox, webhooks, metrics, channel health,
  and claim review. Large Generate/Publish/Comments/PaidReply repositories were
  inspected for critical lifecycle and accounting paths rather than every method.
- Shared/database/infrastructure: lifecycle DTOs, roles, credential encryption,
  migration entry points and online index/backfill behavior, cursor precision,
  development bootstrap, build/test workflow, MCP and search adapters.
- No external publishing or paid model calls were performed. Real provider
  availability, platform delivery, exhaustive transaction interleavings, touch
  gestures, and all mobile layouts are not established by the automated tests.

## Regression evidence

The main reproductions are kept next to their owning modules:

- [MCP lifecycle](../../apps/mcp/src/api.test.ts), [bootstrap](../../scripts/init.test.mjs).
- [Notification pagination](../../apps/api/src/notifications/notifications.repository.e2e.spec.ts),
  [topic history](../../apps/api/src/topics/topics.e2e.spec.ts),
  [news reranking](../../apps/api/src/sources/sources.e2e.spec.ts).
- [Composed capabilities](../../apps/api/src/org/editorial-capabilities.e2e.spec.ts),
  [run retry](../../apps/api/src/runs/runs.e2e.spec.ts),
  [tenant deletion](../../apps/api/src/content/organization-lock-order.e2e.spec.ts).
- [Autopilot](../../apps/worker/src/autopilot/autopilot.e2e.spec.ts),
  [manual checks](../../apps/worker/src/autopilot/manual-trigger.e2e.spec.ts),
  [embedding metering](../../apps/worker/src/generate/generate.service.spec.ts),
  [search XML](../../packages/search/src/yandex-web-search.test.ts).
- [Modal focus](../../apps/web/src/components/ui/modal.test.tsx),
  [poll races](../../apps/web/src/hooks/use-poll.test.tsx),
  [editor saves](../../apps/web/src/app/[locale]/content/[id]/page.test.tsx),
  [guest capability](../../apps/api/src/client-review/client-review.e2e.spec.ts).
- [Worker tenant deletion and multi-tenant sweeps](../../apps/worker/src/organization-lock.e2e.spec.ts).

## Verification

The full forced local test run passed all **4,157 tests in 289 files** across ten
test packages, using real PostgreSQL for database suites; the four bootstrap
script tests also passed. This was followed by checks of later changes in their
affected packages, rather than another unchanged migration-suite run:

- Web: 308 editor/brand/date/poll tests; 275 editor/new-post tests after the final
  rich-save regression and setup link. These overlap and are not additive.
- API: the full 986-test package run included the parent-lock integration;
  updated API build and typecheck also passed.
- Worker: all 563 tests in 43 files passed after the final tenant-lock integration;
  its updated build and typecheck passed.
- Repository-wide lint, the complete workspace build and typecheck passed;
  later API/web/worker builds and typechecks passed separately. No migrations or
  dependencies were changed, and no production branch was updated.

Regression commits precede fixes. The existing publication fan-out concurrency
test's barrier moved from the organization FK to the channel FK: it still parks
both transactions after their distinct adaptation updates and before sibling
reads. Its original status and deadlock assertions are retained. Independent
review verified the resulting interleaving and parameterized multi-tenant sweep
filters.

Browser smoke checks used a separate synthetic database/account: sign-in,
organization creation, brand creation, voice/audience modal typing and saving,
manual channel setup, manual draft creation/edit/save, queue navigation, and AI
settings disclosure. The brand and settings pages were also inspected at
390 × 844. No layout failure was observed in those views; this does not cover
every responsive screen or touch interaction.
