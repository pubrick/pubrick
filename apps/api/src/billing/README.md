# Billing core, before application wiring

These are pure Pubrick domain orchestrators with injected storage/driver ports.
They are not registered in Nest, expose no HTTP routes, and do not activate
hosted subscriptions or quotas. No billing tables/migrations exist in this slice.

## Catalog and checkout

`BillingCatalog.initialize()` validates the driver's current account and every
configured recurring price before publishing an immutable catalog. An unfinished
or failed initialization leaves catalog access closed. Configured internal plan
IDs/versions and capacity limits are server policy; currency, amount and recurring
interval come from authoritative price retrieval. Initial current versions are
supported; persistent historical/deprecated versions require the subsequent
catalog repository before real plan changes are exposed.
Overlapping initialization calls share one in-flight result; subsequent failed
initialization closes the catalog instead of racing an earlier successful load.

`CheckoutCore.start(orgId, userId, planId, locale)` selects that catalog and asks
`CheckoutStore.begin` to atomically authorize the authenticated owner/admin and
commit/reuse an attempt. Contact email comes only from the store. Driver customer
and checkout calls use persisted attempt keys, never newly generated retry keys.
The customer mapping must commit before checkout. Revision conflicts return
`pending`; SDK ambiguity keeps the durable attempt for reconciliation. Successful
checkout URLs are saved before returning `ready` and never grant subscription
access. Store authorization must run even when returning a saved ready result.
The store persists the preferred return URLs only when creating an attempt and
keeps them immutable across retries, including locale changes. Stored URLs must
match the configured public origin and a supported locale's Settings path.
Restoring an unresolved attempt under a different origin requires reconciliation;
it cannot reuse the idempotency key with a changed return URL.

## Durable receipt and reconciliation

`ReconciliationCore.receive` checks readiness, verifies exact webhook bytes and
passes closed verified facts to the inbox. Its promise resolves only after the
store's committed receipt operation. HTTP status/body parsing and raw-byte
preservation remain future integration work: test the actual Nest auth middleware
with `bodyParser: false`; do not assume a bootstrap-only parser applies to tests.

`process` claims a committed processing lease, retrieves current checkout/invoice
relationships, and resolves ownership through persisted provider/environment/
account/customer/subscription mapping. Unknown mappings and deletion tombstones
produce ignored receipts, never access grants. Pending checkout relationships
also grant nothing; the eventual pending-attempt reconciliation must revisit them.

For owned relationships it re-fetches subscription status, checks customer and
identity consistency, and selects the known plan price. `ReceiptStore.apply`
must atomically recheck revision, lease, deletion and subscription ownership;
write authoritative facts and finish the receipt. A revision conflict re-reads
mapping and provider facts, with three bounded passes before recording a retry.
Only closed sanitized error codes reach retry storage. Completed/already-leased
receipts cause no provider I/O. All port operations finish before driver I/O;
implementations must not return open transactions or held row/advisory locks.

## Required next work

- After migration 0118: schema/migration 0119, durable attempts/inbox/catalog,
  operational mapping, retry leases and real concurrency/deletion tests.
- Explicit self-hosted bypass; hosted startup config/account/catalog refusal;
  production refusal of fixture driver. This module makes none of those mode
  selections itself.
- Transactional owner/admin authorization; account workspace/trial admission;
  role/invitation, brand, media reservation and worker concurrency enforcement.
- Organization-before-billing-before-existing-resource lock graph, no lock
  upgrades and no SDK calls under locks. Operational inbox/tombstone rows must
  survive tenant deletion without introducing inverse FK/cascade lock paths.
- Atomic deletion tombstone/outbox, cancellation and pending checkout expiration.
  Late SDK results or checkout completion after deletion cannot recreate access.
  Do not expose hosted deletion before pending attempts can be cleaned up.
- Periodic reconciliation, restored provider/environment/account separation,
  preserved export/delete access after expiry, public billing UI and complete
  test subscription journey. SDK facts/statuses themselves are not entitlements.
- API workspace dependency now includes billing; Docker manifest closure copies
  must include its package manifest when the parent integrates this dependency.

The port contracts and mocked unit tests describe storage obligations; they do
**not** prove real database atomicity or SaaS completion.

## Focused offline verification

After installing the billing package's dependencies:

```sh
pnpm --filter @pubrick/billing exec vitest run \
  --config ../../apps/api/vitest.billing.config.mts --reporter=dot
```

The isolated config aliases billing source, runs only these pure contracts and
does not boot API/auth/SMTP or require PostgreSQL. The normal API test/build tier
uses the explicit workspace dependency and its built declarations.
