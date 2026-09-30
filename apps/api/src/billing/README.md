# Hosted billing storage and orchestration

Pubrick owns the catalog, entitlement revisions, tenant ownership, attempts and
receipts. `@pubrick/billing` owns only maintained SDK transport and normalized
provider facts. This slice includes migration 0119 and constrained controllers,
but **does not enable SaaS** until application registration, actual raw-byte
middleware verification, all growth admissions and transactional hosted deletion
are integrated by the application owner.

## Catalog and entitlement

`BillingCatalog.initialize()` coalesces overlapping loads and verifies the
configured provider account plus actual recurring prices before exposing plans.
`publishCatalog()` persists immutable plan ID/version, scoped price and finite
limits; changing an existing version refuses startup. Currency, minor-unit amount
and recurring interval come from authoritative vendor retrieval. Historical
persisted versions remain resolvable for existing subscriptions and retries but
are not exposed as new purchase choices. A new version requires a new price.

Limits are `seats`, `brands`, `channels`, `mediaBytes`, `concurrentJobs` (safe,
nonnegative integers; seats at least one). Per-account owned-workspace capacity
and lifetime onboarding trial policy belong to separate application admissions.
`resolveBillingEntitlement(orgId, tx, now)` follows an already locked organization
with billing-state `FOR UPDATE`; it returns decision, immutable plan/version,
limits, revision, expiry and provider/environment/account identity. Hosted callers
must compare that identity with their validated configured account, including
after restore. Self-hosted bypass is explicit application policy. Export, deletion
and billing management remain available after expiry.

## Checkout mutation lease

`CheckoutStore.begin` reauthorizes owner/admin membership transactionally and
commits a single unresolved attempt before provider I/O. Customer and checkout
keys, original return URLs, plan/version, provider/account/environment and
issued-at/recovery deadlines are persisted. Return URLs match the configured
public origin and a supported locale Settings path. Locale changes retain the
original payload; a different restored public origin refuses automatic reuse.
No contact email or credential secret is stored in retained operational rows.

A bounded lease covers the unresolved mutation. Revision/token/expiry fencing
prevents stale completion from returning ready or granting access. Known late
external IDs are retained for retrieval or cleanup. SDK ambiguity does not permit
a fresh key: recovery stops after 23 hours, conservatively below Stripe's minimum
24-hour key retention, leaving an `operator_action` obligation. A known external
checkout ID is always retrieved, never recreated after the retention window.

Stripe may prune keys after at least 24 hours; reusing a pruned key can execute a
new operation: [official idempotency reference](https://docs.stripe.com/api/idempotent_requests).

## Receipt and periodic reconciliation

Webhooks require the exact original bytes and a single bounded signature header.
Signature verification precedes durable unique provider/account/environment/event
receipt insertion and acknowledgement. Only closed event ID/kind/resource facts
are stored; raw provider JSON, headers, secrets and emails are not retained.
Unsupported signed event kinds are acknowledged without grants.

Processing claims a short committed lease; network calls happen after locks are
released. Authoritative relationships and subscription facts are re-fetched.
Tenant ownership uses immutable customer/account mappings; metadata/email never
establish authorization. Unknown customers grant nothing. Mapping revision and
receipt lease are checked again before an entitlement changes. Historical
subscriptions cannot replace a newer selected subscription; conflicting new
subscriptions while current access is live create cancellation obligations.
Pending relationships retry, and independent bounded periodic scans reconcile
pending checkouts and existing subscriptions even when a webhook never arrives.
Subscription pages advance a durable `nextReconcileAt` before provider I/O, so
failed earlier pages cannot starve newer subscriptions. Ready checkout reads
likewise advance before lookup. Receipt/cleanup retries use exponential delays
from 30 seconds to one hour, stop after 12 attempts, and send permanent failures
to retained `operator_action` state. Known subscriptions remain periodically
repairable with capped counters; their authoritative status still controls access.

## Deletion and cleanup

Operational account mappings, attempts, receipts, subscriptions and cleanup rows
have no tenant cascade FK. They retain opaque org IDs exclusively for privileged
scoped scans; the public API does not expose these rows. Only entitlement state
cascades with the organization. Deletion takes run-admission advisory, organization
`FOR UPDATE` directly, then billing state/account/resources in that order.

The application MUST invoke `BillingRepository.tombstoneInTx(orgId, tx)` inside
**the same transaction** that deletes the organization. A before-delete callback
is insufficient. Hosted raw Better Auth deletion stays disabled until this
transactional path exists. Tombstones and cancellation/expiration outbox rows
commit before removal; SDK calls occur afterwards under bounded cleanup leases.
Late SDK results append retained obligations instead of recreating tenant access.
Open checkouts expire; complete checkouts yield late subscription cancellation.
Complete checkout with a delayed relationship stays retriable. Unknown creation
past the recovery deadline or a changed configured account requires operator
attention; it must not silently become a fresh charge or use ambient credentials.

## Application integration

Construct `BillingRepository(db, driver.identity)`, `BillingCatalog(driver,
serverPlans)` and `BillingService(driver, catalog, repository, publicOrigin)` in
explicit hosted mode. Await `service.initialize()` before enabling processing.
Register `BillingController` and `PublicBillingController`; own scheduling and
shutdown of bounded `service.sweep()` ticks in the application lifecycle.

Routes: public `GET /api/billing/plans`, signed `POST /api/billing/webhook`;
owner/admin `GET /api/billing`, `POST /api/billing/checkout` (`planId`, `locale`)
and `POST /api/billing/portal` (`locale`). Clients cannot supply vendor price,
customer, account, return URL or entitlement limits. The actual Nest stack uses
`bodyParser: false`: application wiring must prove middleware preserves
`request.rawBody` before exposing the webhook route, including whitespace and
signature-tampering tests. Unit byte extraction does not prove middleware behavior.

Fixture mode is for explicitly disposable offline stacks and is refused in
production. Restarting an empty in-memory fixture driver under an existing
persisted fixture identity can collide with retained generated IDs. Hydrate an
explicit validated fixture inventory or refuse startup for nonempty fixture
identity; never synthesize paid responses from checkout success. Stripe sandbox
restart instead retrieves authoritative external facts through its maintained SDK.

## Local verification

Pure contracts, no API boot/database/SMTP:

```sh
pnpm --filter @pubrick/billing exec vitest run \
  --config ../../apps/api/vitest.billing.config.mts --reporter=dot
```

The persistence tier ignores ordinary `DATABASE_URL`. It requires an explicitly
owned disposable loopback database named `pubrick_billing_*`, and migrates only
that database. Build shared/database/billing declarations first, then:

```sh
PUBRICK_BILLING_DISPOSABLE=1 \
BILLING_TEST_DATABASE_URL=postgres://postgres:fixture@127.0.0.1:31432/pubrick_billing_test \
pnpm --filter @pubrick/api exec vitest run \
  --config vitest.billing-persistence.config.mts --reporter=dot
```

Contracts test lease races, immutable retry payload, late completion after
transactional deletion, durable receipt uniqueness/reclaim, closed expiry policy,
no-webhook checkout recovery and historical subscription isolation. Application
admissions, full hosted browser payment journey and actual raw parser integration
remain separate required acceptance gates.

## Hosted runtime configuration

`billingEnvironmentSchema.shape` composes into the API environment schema.
`parseBillingConfig(values, { deploymentMode, nodeEnv, publicOrigin })` returns an
explicit disabled configuration for self-hosted instances. Hosted startup requires
`BILLING_DRIVER`, `BILLING_ACCOUNT_ID`, `BILLING_CATALOG_JSON`,
`BILLING_MAX_OWNED_WORKSPACES` and `BILLING_MAX_CREATES_PER_DAY`. Both account
limits must be positive safe integers. Initial BYOK trials are disabled; no
commercial price or entitlement is supplied by this package.

The operator catalog is a nonempty JSON array of `{ id, version, priceId, limits }`.
Limits contain exactly `seats`, `brands`, `channels`, `mediaBytes`, and
`concurrentJobs`: finite nonnegative safe integers, with at least one seat.
Stripe sandbox requires `BILLING_STRIPE_SECRET_KEY` (`sk_test_`) and
`BILLING_STRIPE_WEBHOOK_SECRET` (`whsec_`). The maintained SDK validates the
configured account and retrieves actual recurring price facts before startup
completes. Fixture mode requires explicit `BILLING_FIXTURE_PRICES_JSON` facts,
a loopback public origin, and a nonproduction process. Retained operational rows
or entitlement state for the same fixture identity refuse startup, including
receipts and tombstones. A fresh empty simulator cannot recover external IDs.

`BillingModule.forRoot(config, database?)` exports the repository, service and
runtime. `BILLING_DATABASE` is an explicit injection token; without an override,
the module reuses the API's existing database instead of opening another pool.
Its async provider finishes account/catalog validation before controllers become
ready. The parent application must still install the exact raw webhook parser
and coordinate hosted capacity/deletion admission.

`BILLING_SDK_TIMEOUT_MS` defaults to 2000, bounded to 100–5000;
`BILLING_TICK_BUDGET_MS` defaults to 10000, bounded to 100–30000;
`BILLING_SWEEP_INTERVAL_MS` defaults to 60000, bounded to 1000–3600000.
A tick checks its budget before claiming each durable unit, including single-row
periodic subscription leases. Shutdown closes admission and drains its current
unit, which can contain multiple SDK calls and short database transactions. The
SDK timeout bounds each network call; it is not a claim that the whole unit or a
blocked database completes within one timeout. No mutation is abandoned halfway.
Scheduler diagnostics expose only closed domain codes and aggregate deferred or
failed status; logging never includes provider messages, secrets or raw bodies.

## Billing status read contract

Manager-only `GET /api/billing` returns sandbox `mode: "test"`, `funding: "byok"`,
closed status, immutable `{ id, version }` plan, validated limits, usage, ISO expiry,
cancellation flag and action availability. The repository rechecks the actor and
scope under the organization admission lock. Current state must match the
configured provider/environment/account; an old restored account cannot advertise
new purchase or portal actions. A pending checkout never grants access or limits.
Fixture purchase/portal URLs are simulator fixtures, so both actions are unavailable
in the browser even when a fixture customer exists.

`usage.seats` counts distinct member user IDs plus distinct lowercased pending,
unexpired invitation emails not already represented by member emails. This matches
the hosted admission domain's canonical stored addresses. Brands/channels are
actual organization rows; media is the sum of stored asset bytes.
`usage.concurrentJobs` currently counts only genuine queued/running pipeline rows.
It does not claim to cover every infrastructure job, AI auxiliary operation, or a
future durable reservation ledger; that admission integration is a separate gate.
No customer IDs, subscription IDs, secrets, external URLs or raw provider facts
are exposed by this status DTO.
