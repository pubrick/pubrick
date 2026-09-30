# Billing drivers

`@pubrick/billing` is a server-only boundary for subscription providers. It is
not an implemented checkout screen, billing repository, quota service or live
commercial offering. Applications must explicitly select a driver; importing
the package does not initialize a client or require payment credentials.

## Supported adapters

- `StripeSandboxDriver` uses the official `stripe` SDK **22.6.2**, pinned so SDK
  types and its bundled API version move together. The SDK is MIT licensed and
  supports the project's Node runtime. It owns HTTP transport, request timeouts,
  webhook signature verification and API serialization.
- `FixtureBillingDriver` is an offline deterministic simulator. It returns local
  loopback URLs and configured subscription snapshots. Its exact-match webhook
  tokens are **not cryptographic signatures**. The consuming disposable test
  application must implement the fixture URLs and explicitly enable this driver;
  it must never be selected for a public deployment.

The sandbox adapter rejects live keys, live events and live subscription facts.
There is intentionally no live adapter or fabricated price catalog. Seller
eligibility, provider choice and real commercial configuration remain operator
decisions. [Stripe's availability](https://stripe.com/global) varies by seller
location.

The official SDK was chosen over hand-written REST/signature code. The
[Better Auth Stripe plugin](https://better-auth.com/docs/plugins/stripe) handles
many subscription workflows, but would introduce a second subscription store
and vendor-specific auth integration. Pubrick retains domain persistence and
admission policies outside this package, allowing future vendor drivers.

## Contracts

Every verified event and authoritative subscription snapshot carries
`provider`, `environment` and `accountId`. The direct-account sandbox adapter
rejects connected-account/context events. `accountId` is operator configuration:
operators must verify it matches the sandbox API key and webhook endpoint; an
ordinary direct-account webhook does not contain evidence of that account ID.
Fixture facts must match the configured fixture identity.

`createCheckout` accepts server-resolved customer/price IDs, success/cancel URLs
and a **stable persisted attempt key**. It forwards that key to the SDK. Calling
applications must authorize the organization and resolve these values from their
own mapping/catalog, never directly from client values, email or vendor metadata.
Validate return URLs against the configured public origin in the application;
the driver additionally rejects embedded credentials and non-HTTPS URLs except
local loopback test URLs.

`createPortal` follows the same customer ownership, origin and idempotency rules.
Session results contain external IDs and URLs; they never imply paid access.

`verifyWebhook` requires the exact raw request bytes and signature header.
Never parse and reserialize JSON before verification. The maintained SDK checks
the signature and timestamp tolerance. The adapter returns closed event kinds
and external resource IDs, excluding metadata/customer secrets. Supported events
are subscription creation/update/deletion/pause/resume, checkout completion and
async payment outcomes, and invoice paid/failure/action-required/finalization
failure. Unknown events are rejected; configure only supported endpoint events.

`retrieveSubscription` returns current subscription facts. This initial adapter
supports one recurring item with quantity one; multiple items, pagination,
unknown statuses or malformed periods fail closed. Periods come from the item,
not the removed subscription-level period fields. Closed statuses are facts,
**not entitlements**: an application must explicitly decide access for active,
trialing, incomplete, past-due, unpaid, paused and canceled subscriptions.

Errors are `BillingError` with a closed code. Provider messages, response bodies,
causes and credentials are not attached. Treat `timeout` and `unavailable` as
ambiguous outcomes: an external operation may already have succeeded. Retry
using the same durable attempt key and reconcile, rather than creating a new
checkout. SDK network retries are disabled for predictable admission, but the
SDK can still retry a closed connection once with the same idempotency key.

## Responsibilities outside the driver

Pubrick repositories must own organization/customer/subscription mappings,
durable unique event receipts scoped by provider/account/environment, revision
checks, reconciliation, plan versions and transactional capacity reservations.
An event is a reconciliation hint, not a grant. Webhooks can be duplicated,
missing or delivered out of order; retrieve authoritative state and apply it
atomically with successful receipt handling. Timestamp ordering is insufficient.
Checkout redirects cannot activate access. These rules follow the
[official webhook guidance](https://docs.stripe.com/webhooks).

An offline driver does not prove hosted billing acceptance. Add real sandbox
checkout, cancellation, renewal/failure and customer portal tests once a
provider sandbox is explicitly configured. [Billing test clocks](https://docs.stripe.com/billing/testing)
can advance subscription periods without real payments. Preserve mappings,
receipts and pending attempts in backups; restoring must not automatically
enable live processing.

## Focused verification

```sh
pnpm --filter @pubrick/billing test
pnpm --filter @pubrick/billing typecheck
pnpm --filter @pubrick/billing build
```

Unit contracts use the real SDK with a Fetch-compatible fixture transport and
SDK-generated signatures. They make no external requests and use synthetic
credentials only. Official implementation reference:
[stripe-node](https://github.com/stripe/stripe-node).
