# Hosted beta design

Status: draft for adversarial review; not an implemented SaaS offering.
Updated: 2026-09-30.

## Product and initial funding

Pubrick remains one AGPL product with self-hosted and hosted deployments. The
hosted service sells operation of the service: users register and work without
installing a server. Human approval before delivery remains required.

Build the first hosted subscription path with BYOK. This is a reversible
implementation assumption, not an owner-approved commercial package: no funding
preference has been supplied yet. Keep platform-funded AI as a separate next
slice. Do not advertise included credits until reservations, provider routing,
and settlement are implemented for every billable entry point. Subscription
prices and production checkout require operator configuration; do not invent a
selling entity or publish a fictional live purchase flow.

## Billing boundary

- Use maintained vendor SDKs behind a small billing driver. Signature validation
  uses the SDK against the raw request body. Do not hand-roll webhook crypto.
- Explicit instance mode selects self-hosted or hosted. Missing hosted billing
  configuration is a startup refusal, not an unlimited hosted installation.
  Self-hosted without billing configuration remains fully usable.
- Hosted registration must explicitly use the open registration policy; the
  self-hosted first-account bootstrap closes registration after the first user.
  Open hosted registration also requires verified account ownership and abuse
  controls before live beta; current manual invitations do not verify email.
- An organization owns its subscription; an authenticated owner/admin may manage
  checkout and the customer portal. Users may belong to multiple organizations.
  Never derive billing ownership from an email address alone.
- An internal plan identifier maps to an operator-configured vendor price and
  versioned entitlements. Clients cannot supply a price, entitlement, customer
  ID, or subscription status. Provider metadata alone never authorizes access.
- Checkout success redirects show pending confirmation until the backend has
  verified authoritative state. A returned URL is not proof of payment.
- Concurrent checkout attempts share a durable organization-level pending
  attempt and a stable provider idempotency key. Two browser tabs must not
  create independent subscriptions.
- Persist processed vendor event IDs with a unique constraint. Resolve the
  current authoritative subscription state rather than trusting delivery order.
  Serialize updates per organization, recheck ownership/mapping, and commit
  state and event receipt atomically. Failed processing remains retryable.
- Reconciliation repairs dropped webhooks. Network calls use timeouts and happen
  outside row-lock transactions. Recheck the reconciled revision on commit.
- Keep exact webhook bytes before JSON parsing. Provider account and sandbox/live
  identity belong in both mappings and receipts; reject events for another
  environment. Restoring a snapshot must not silently enable live processing.
- Organization deletion schedules retryable external cancellation and retains
  a minimal billing tombstone until reconciliation completes. Late events must
  not recreate a deleted workspace or grant access.
- Document active/trial/past-due/cancelled behavior, grace periods and period-end
  cancellation. Export and deletion remain available after subscription expiry;
  an expired account must not lose the ability to retrieve its own data.

## Admission and tenant boundaries

Entitlements are server-owned. Plan checks must not depend on a hidden button.
Self-hosted bypass is an explicit mode decision, never a request header.

Apply account-level organization/trial admission as well as organization-level
entitlements: opening a new unpaid workspace must not reset a paid allowance.
Cap unpaid organization creation and trial claims with durable, concurrent-safe
records; invitations do not start independent trials. Configured trial policy
and grace periods are operator choices, not hardcoded commercial promises.

Storage admission needs a backfill of existing retained media, plus explicit
semantics for deleted objects, replacement uploads and in-flight reservations.
The byte counter must be reconcilable against durable storage. A restore or
missed cleanup cannot silently reset billable resource usage.

Enforce resource creation at the write transaction: brands, seats/invitations,
media byte reservations and asynchronous job concurrency. Invitation acceptance,
role changes, replacement uploads and worker jobs must use the same policy as
manual UI actions. A plan downgrade preserves existing data but refuses growth
past the new allowance; it must not delete content to make a counter fit.

The project already serializes organization deletion against child writes and
has a documented product lock order. Billing/admission locks need a reviewed
position in that order before a migration or repository change. A separate
billing table must not introduce an inverse lock path through foreign keys.

BYOK usage is reported as provider spend, distinct from the subscription fee.
Unknown model cost stays unknown. Hosted infrastructure limits must be stated
in user-facing units and exercised under concurrent requests.

Platform-funded AI needs its own design and must cover generation/refine,
readaptation, probes, website import, claim review, reply analysis, relevance,
suggestions, knowledge indexing/search and image calls. Reserving only a draft
run does not cover these physical model calls or SDK repair retries. Existing
usage-ledger rows record actual calls; they are not a monetary admission lock.

## User journey

A public product site states verified capabilities, self-hosted availability,
BYOK requirements and the configured plans. Hosted registration takes the user
through workspace setup, subscription confirmation, brand/channel setup and a
first draft. Settings contains subscription status, current limits, usage and
one management action beside the relevant information. Preserve the existing
locale, accessibility and independent-form conventions.

No live checkout button appears when billing is disabled or in test mode.
Test mode is visibly labelled. Do not display a live price or payment claim
without a configured catalog. Payment failures and pending confirmation have
recoverable states; refreshing or repeating a checkout cannot grant access twice.

## Verification and launch dependencies

Before beta: mock transport contract tests for each driver; real vendor sandbox
webhook verification; duplicate/out-of-order/dropped event cases; tenant access
and owner/admin/member cases; concurrent quota admission; cancellation and
plan-change journeys; billing-disabled self-hosted regression coverage; export
and account deletion; disposable backup/restore including billing receipts.

The initial local driver slice uses the maintained official Stripe SDK behind
the replaceable boundary, plus a deterministic fixture driver. This is a sandbox
implementation choice, not a decision that Stripe is available to the eventual
selling entity. Pubrick owns subscription state and quota admission; the Better
Auth billing plugin would introduce a second subscription authority here.

Implementation references: [Stripe SDK](https://github.com/stripe/stripe-node),
[webhook ordering and retries](https://docs.stripe.com/webhooks),
[billing test clocks](https://docs.stripe.com/billing/testing), and
[supported seller regions](https://stripe.com/global).

Live launch additionally needs an operating entity, payment account, public
origin/domain, deployment region, configured prices/limits, retention and support
policy, and monitored infrastructure. These operator inputs do not prevent
local development and sandbox verification. A public beta cannot be declared
ready until the external user journey and recovery acceptance are demonstrated.
