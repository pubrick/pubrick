# Hosted platform integration — 2026-09-30

This feature milestone follows `hosted-foundation`. It is not a commercial
launch and does not change production `main`.

## Integrated capabilities

- Explicit workspace text-provider selection and immutable credential provenance
  on new generation runs. Legacy checkpoints without identifiable credentials
  refuse paid execution rather than borrowing a current key.
- Vertex and guarded OpenAI-compatible BYOK adapters, alongside existing direct
  providers. Replacement keys, tenant permissions and physical-call accounting
  are exercised using local transport fixtures, without paid provider calls.
- Durable encrypted authentication mail through the shared PostgreSQL outbox and
  worker. Invitation writes can enqueue mail in their existing transaction;
  retries retain a stable message identity and recheck current token ownership.
- Manager-only workspace export: explicit tenant field allowlists, original media,
  file hashes and a complete archive manifest. A private bounded staging archive
  finishes its database snapshot before HTTP delivery. A dedicated Next route
  avoids the short rewrite proxy timeout. Private archive retention is bounded;
  exports exclude authentication secrets and billing operational state.
- Identity-scoped sandbox billing persistence: immutable catalogs, verified receipt
  inbox, checkout recovery, fair subscription reconciliation and durable external
  cleanup obligations. Configuration validates the operator account before HTTP
  readiness. Persisted fixture inventory refuses unsafe empty-driver restart.
- Signed webhooks use the existing Nest Express raw-body parser before JSON
  middleware, with a one MiB limit and compressed-body rejection.
- Hosted resource growth policy rejects expired access, foreign restored billing
  accounts and limits exceeded by the proposed delta. Zero-growth membership
  remains accessible after a downgrade.

## Verification and corrections

The integrated build and typecheck at `7d5584b8` passed 24 tasks. A full relevant
suite was attempted once: web 1,472 passed with two authorship-text failures;
DB 132 passed with one historical migration expectation failure; worker 572
passed with four generation fixture failures; API 1,037 passed with seven fixture
failures. Those failed commands are not reported as all-green runs.

Corrections preserved production policy: neutral export copy replaced claims of
original authorship; the historical default was pinned to its actual metadata-only
value; generation fixtures now establish real credential provenance; native mail
fixtures derive their configured origin. Focused follow-up verification follows
below. Unchanged passing tiers included shared 479, Telegram 32, search 9,
integrations 134, mail 23, AI 402, billing 83 and MCP 16 tests.

New raw webhook HTTP regressions passed 3/3; hosted growth policy passed 5/5.
Provider adapter checks independently covered API 102, worker 12 and Settings 80
cases, plus transport and database upgrade fixtures. Durable billing persistence
passed nine native DB regressions, and its runtime passed 41 focused checks plus
an inventory startup regression. No live emails, publications, payments or paid
model calls were performed.

## Final milestone gate

The integrated workspace build and typecheck passed **24/24 tasks**. After the
last controller and membership fixes, API/web types passed **9/9 dependency
tasks**, and full Biome passed **933 files** without changes.

Focused follow-up passed **101 API tests in 15 files**, including native atomic
mail and the previously failing generation admission fixtures; **five worker
checkpoint regressions**; and **eight DB policy/historical timestamp checks**.
The native HTTP contracts passed **16 tests**, covering the billing status route,
trusted-origin JSON writes, unchanged anonymous signed webhooks, server-derived
actors and persisted invitation response fields. Web transport passed **34 tests**.
Separately, the hosted UI slice passed **154 tests**, with two further affected
confirmation/recovery cases; admission passed **20 native/pure cases** and three
final migration/response checks. A nondeterministic legacy duplicate-member
selection was fixed by checking every locked membership for actual manager rights;
no historical memberships were deleted.

The compiled API and production Next browser journey passed in **10.3 seconds**:
account creation, workspace/brand/manual draft, persisted editing, locale and
workspace switching, and downloading a real workspace archive containing the
edited draft and complete manifest. The runner removed its isolated servers,
media directory and disposable database. No GitHub Actions workflow was dispatched.

## Remaining acceptance

Hosted controller/module composition now binds seat checks, durable invitation
mail and deletion tombstones. Later integration below registers it in the
validated application runtime and adds transaction-bound request authority.
Resource/concurrency admission and durable deletion have local native coverage.
The hosted browser journey remains an integration acceptance gate. Initial trials
are disabled. Seller details, domain, plans,
prices and a real payment sandbox account are operator inputs, not inferred
product values. No live paid checkout is advertised by the fixture adapter.
A real versioned release artifact and live commercial launch remain separate
acceptance gates.


## Resource, physical dispatch and deletion milestone

The next integrated package covers every production brand/channel/media writer,
including normalized worker images and crops; all three pipeline admission paths;
and each physical text, image, embedding, token-count and credential-probe request.
Model retries acquire separate durable leases and pass cancellation to the actual
transport. Local capacity refusals create neither provider calls nor phantom usage
reservations. Independent review identified and fixed the manual token-count and
brand-import paths that initially bypassed these scopes.

Deletion now stages immutable asset ownership proof in the same transaction as
metadata removal. A bounded worker performs canonical-path unlink, retries failed
storage operations, fences stale acknowledgements and preserves live assets.
Missing storage roots retry rather than falsely completing deletion. Organization
cascade retains the cleanup obligation; these operational rows and dispatch leases
are explicitly excluded from workspace exports.

Fresh migration 0123 adds cleanup work and renames five equivalent CHECK constraints.
Constraint renames retain their predicates and validated state. Earlier migrations
were not rewritten. The enum migration scanner transfers only already established
proof when interpreting a rename, and billing/dispatch columns now expose the same
closed sets in TypeScript and PostgreSQL.

### Local verification

The integration build/type gate reached 23 of 24 successful tasks; its remaining
API fixture type errors were corrected and the affected API typecheck then passed.
Earlier attempts exposed literal widening, an unsupported refusal code, positional
native-call tuple types and invalid test fixture shapes. Those failures were fixed,
not skipped or counted as passes. The current production sources build and typecheck.

Built-package focused runs passed **91 AI**, **55 API** and **39 worker** tests.
PostgreSQL admission/clock/schema checks passed **56 tests**. Native API cleanup,
resource, queue and billing persistence checks passed **36 tests** after correcting
the fixture builders behind nine cases that violated existing media/channel constraints. On a separate empty
database, native worker cleanup and scheduled admission passed **13 tests**. These
counts describe separate runs; some helper assertions intentionally overlap.
No live LLM, email, payment, publication or GitHub Actions dispatch was used.

### Next integration

Hosted runtime activation, transaction-bound request authority and legacy
membership role union are integrated in the following slice. The completed
resource package does not by itself establish hosted beta acceptance. The fixture
billing driver never represents a real paid checkout, and initial trials remain
disabled. Versioned public release and commercial launch remain acceptance gates.


## Hosted runtime and authority integration

Validated hosted configuration now registers billing and custom workspace
admission in the real Nest application. Missing or malformed operator
configuration refuses startup. Raw Better Auth organization writers, including
server-only member addition, cannot bypass this boundary. Self-hosted mode retains
its explicit billing-disabled behavior; no initial trial is granted.

Successful guards capture an immutable server-derived request authority. The
Observable subscription enters its asynchronous context, so resource creation,
queue admission and physical model leases recheck the persisted actor after
waiting on the shared tenant lock. Revoked/expired sessions, unverified users,
removed/downgraded members and lost brand grants refuse the next dispatch or write.
An already admitted physical call may finish; its next retry needs fresh authority.
Worker system jobs use their separate trusted domain admission. Public read-only
API keys cannot authorize resource growth or paid calls.

Legacy duplicate membership rows now contribute their recognized roles to the
application guards, brand access and manager checks, without destructive data
deduplication. Independent review reproduced five remaining first-row manager
checks and corrected them, including ordered member locks during Telegram login.
Raw self-hosted Better Auth invitation permissions remain the SDK's own policy.

### Local evidence before the final assembled gate

Runtime composition passed **14 native cases**, including local SMTP, custom
invitation acceptance, SDK bypass denial, origin/JSON enforcement, recovery and
legacy authority. Request authority passed **eight native race cases** plus one
positive admitted-response case; its focused helpers passed **35 cases**. API
types and the changed DB package build passed. The assembled workspace at
`866dd365` then passed **24/24 build and type tasks**. Subsequent manager fixes
reproduced six failures before **11 focused cases** passed.

Provider review also reproduced false invalid-key reports from HTTP 403. The
shared classifier, untagged probe fallback and Vertex OAuth now distinguish a
request refusal from HTTP 401 authentication failure; 403 alone proves neither
key acceptance nor invalidity. Mocked successful OAuth followed by model 403
retains one unpriced model receipt; OAuth refusal before model dispatch has none.
The affected AI tier passed **58 cases**, with one isolated API fallback case.
The final assembled gate below uses the rebuilt AI package.

### Browser acceptance corrections

The hosted runner uses a disposable database, synthetic secrets, local SMTP and
authenticated local fixture control. Its deterministic entitlement is test setup,
not an actual payment. No live model, publication or payment action is performed.

Initial attempts exposed runner faults: an incorrect worker artifact path and a
synchronous Playwright child that blocked the runner's own SMTP/control listeners.
Both were fixed; mail capture now runs independently of optional queue diagnostics.
A subsequent real-browser attempt verified email and exposed a product bug:
successful hosted login supplied the verification callback URL to the auth SDK,
which redirected back to verification. Red regressions preceded removal of that
callback from sign-in; **14 AuthForm tests** passed, preserving default and explicit
next-page navigation. Further attempts corrected fixture assumptions about the successful brand CTA,
translated role label and awaiting a persisted channel before navigation. These
failed attempts are not passing acceptance.


### Assembled hosted journey

At `477383df`, the compiled API/worker and production Next artifact passed the
hosted journey in **35.2 seconds** (**36.8 seconds** including the deliberately
skipped self-hosted spec). Its build passed **11/11 tasks**, and browser-runner
TypeScript passed. The journey follows the real authenticated landing CTA rather
than assuming a signup/login automatically creates a workspace.

Verified actions: local SMTP verification and login; custom empty workspace;
unpaid brand refusal and raw SDK growth denial; identity-scoped fixture
entitlement; brand/manual channel; saved and reloaded human draft; manual
knowledge note; delivered invitation; second independently verified user and
acceptance; last-seat refusal; expired growth refusal while existing draft reads,
a complete real archive export and workspace deletion remain available. The
archive includes the edited draft and knowledge note, and excludes the password.

The fixture entitlement is a deliberate DB setup, not checkout settlement.
Deletion proves tenant access removal; the synthetic subscription may retain an
external cancellation obligation because it does not exist in the in-memory
vendor fixture. Real sandbox checkout/portal/cancellation still require an
operator payment account. The runner removed its exact container, media and
servers; all four reserved ports were free afterwards. The user's existing local
installation and credentials were not changed.

### Final affected backend gate

Against rebuilt package exports, the complete AI tier passed **434 tests in 19
files**. The affected API tier passed **64 tests in six files**, including **15
native resource/queue cases** with actual verified DB sessions and the production
actor callback retained. Anonymous or revoked actors create no admitted write,
run or enqueue. Existing quota, rollback, crop revision and file cleanup assertions
remain enforced. No live email, model, payment, publication or Actions dispatch was
used in this gate. The dependency/type tier passed **19 tasks**. The first full
Biome run found only two fixture-format differences; commit `01adfd8f` corrected
those without changing behavior. The subsequent storage gate below reruns the
full formatting check.


### Retained media storage admission

Review found an actual hosted storage bypass: logical deletion removed bytes
from usage before the worker physically deleted the file. With a stopped worker,
repeated upload/delete cycles could keep growing retained storage. A native red
regression preceded the fix; pending and operator-action cleanup proofs now
retain their captured positive byte sizes until completion. Fresh migration
0124 adds the nullable proof field, scoped index and positive-value constraint.
Historical unknown proof sizes refuse media growth; they are never interpreted
as zero.

Admission checks total live plus retained bytes but verifies the inserted delta
against live metadata only. Concurrent cleanup acknowledgement therefore does
not cause a false growth mismatch. A restored identical UUID/tenant/kind is
counted once, and staging preserves immutable ownership and lease fencing.
Settings reports only the typed reconciliation-required condition as unknown
media usage; known subscription state and management actions remain available.
Unexpected database or counter errors still propagate. Four locales share the
unknown-usage explanation.

Independent review at `f814b990` found no actionable defect in these boundaries.
This accounts for committed metadata and retained deletion proofs, **not a hard
filesystem cap**: process crashes before metadata insertion can leave unowned
prepared files. The documented recovery requires paused writers, storage
reconciliation and an operator physical capacity limit.

The assembled source at `f814b990` passed **24/24 build and type tasks**, including
production web, API and worker artifacts. The assembled affected gate passed
**86 tests**: DB resource/schema/timestamp **50**, API deletion/admission/status
**27**, shared billing DTO **1**, and BillingCard **8**. Full Biome checked **990
files** without changes. The fresh migration also passed the implementation
worktree historical upgrade/order and constraint inventory checks (**3 tests**);
its native storage regression included a real private 100-byte file retained
after logical deletion.

The final production browser journey at `f814b990` passed in **38.2 seconds**
(**40.7 seconds** including the intentionally skipped self-hosted spec). All
**11 build tasks** reused the verified artifacts. This repeats the assembled
journey above against migration 0124 and the nullable billing DTO; fixture
entitlement still does not prove a real payment checkout. The runner removed
its exact container/media/processes, and ports 31310–31313 were free afterwards.


### Main integration follow-up

Owner-authorized fast-forward integration of `474e28a4` reached remote `main`.
The automatic CI run [36760009141](https://github.com/pubrick/pubrick/actions/runs/36760009141)
passed lint, build, types and root script tests. Its web tier passed **1,505
tests** and failed one environment-declaration guard: the server workspace
export route reads `API_INTERNAL_URL`, which was declared for build but omitted
from the Turbo test environment. Later task tiers were not completed by that
failed run; it is not a passing whole CI gate.

The same guard failure was reproduced locally (**1 failed, 6 passed**) before
adding the variable to `tasks.test.env`. The unchanged guard and export-route
contracts then passed **9 tests** in two files. This corrects environment
forwarding and cache identity without weakening the gate or changing the route.
No remote rerun or manual Actions dispatch was requested. A further main push
requires fresh owner authorization for the reviewed follow-up HEAD.


### Operator status milestone

Implemented in `53c645df` (author worktree `204e9a3e`): `pnpm ops:status`
requires the explicit project and matching absolute checkout. It verifies ordered
Compose overlays, configured and runtime API/worker billing identity, PostgreSQL
user/database and internal DB targets. It reads only fixed aggregate fields in a
read-only transaction with statement/lock/subprocess bounds. Secrets, tenant IDs,
mail contents and raw driver errors are excluded. This is an operational snapshot,
not provider readiness or proof of delivery/payment.

Independent review identified unordered-overlay acceptance and stale worker
identity acceptance; both were corrected before integration with regressions.
The source author passed **11 offline contracts** and an explicit **25.17-second
native acceptance** using real migration 0124 and pg-boss queues. The native
fixture included unknown/completed media proofs, terminal billing cleanup and
live/expired physical-call fences. Its exact Compose resources and temporary
dependencies were removed.

After integration, the root script suite passed **34 tests**, with **2 explicit
opt-in native checks skipped**; their skips are not native evidence. Full Biome
checked **993 files** without changes. The export environment follow-up above
passed its **9 affected web contracts**. No remote rerun or manual Actions
dispatch was performed. The operator runbook links existing identity, billing,
media and backup/recovery procedures without inventing support or retention policy.
