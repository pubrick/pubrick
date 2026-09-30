# Tenant resource admission

`packages/db/src/resource-admission.ts` provides transaction boundaries for
hosted brand, channel and media growth. It reuses the central billing entitlement
and quota policy; it does not read environment variables, mint subscriptions or
accept a browser-provided plan. Mode and operator billing identity come from
trusted instance configuration.

## Boundaries

`withTenantResourceAdmission(orgId, db, mode, growth, insert)` opens a transaction:

1. Acquire `RUN_ADMISSION_LOCK_NAMESPACE` / `hashtext(orgId)` advisory.
2. Acquire organization `FOR KEY SHARE` directly, without a weaker-lock upgrade.
3. Read actual tenant usage: all brand rows, all channel rows, or the sum of
   live media bytes plus retained physical-deletion obligations across every brand
   and media kind, using `getTenantMediaStorageUsage(orgId, tx)`.
4. Call existing `authorizeBillingGrowth` inside the transaction, which locks the
   central billing state and verifies the configured operator identity.
5. Run the database-only insertion callback in that same transaction.
6. Recount actual usage and require the exact declared increase before commit.

Brand/channel growth declares exactly one row. Media growth declares the positive
safe-integer byte length of the **normalized file that will be persisted**, not
its original upload, provider response, declared MIME or an estimated size. SQL
aggregates are returned as text and decoded using native `BigInt`; negative,
fractional, missing or unsafe totals fail closed instead of losing precision.

The callback may insert only the resource growth it declared. A different actual
increase or insertion failure rolls back; billing refusal never invokes it.
Uploads, generated images, covers, inline illustrations and crops all contribute
to the same media accounting. There is no resettable counter. Migration 0124 adds
byte proofs to retained cleanup requests; unknown historical proofs require operator
reconciliation before further hosted media growth.

Self-hosted mode preserves existing behavior: it does not acquire hosted advisory
or tenant locks, count usage, or query billing. It executes the insertion callback
inside the caller's transaction boundary and keeps basic numeric input invariants.

## Existing transactions

`withTenantResourceAdmissionWithHeldLocks(orgId, tx, mode, growth, insert)` is for
callers that **already acquired the shared advisory before the organization lock**.
It never reacquires that advisory or tenant rows. It must not be used as a way to
skip acquiring those locks; that is an internal repository contract, not a public
HTTP capability.

Integration must apply the same advisory to **resource deletion**, before tenant
and child locks. Otherwise a concurrent deletion can reduce the post-insert total
and produce a conservative `growth_mismatch` rollback. The helper safely refuses
that race, but it does not claim a smooth workflow until deletions are coordinated.

Integrated write paths use the same hosted admission boundary: API brand and
channel creation, image/video uploads, generated covers/inline images, crops, and
worker generated images. Hosted brand/channel/media deletion acquires the shared
advisory before tenant and child locks. Files are prepared outside the database
insertion callback; transaction refusal preserves cleanup of the prepared file.

Do not perform filesystem work, network calls, SDK calls or image decoding inside
the insertion callback. Prepare a bounded private file first, derive actual bytes,
and clean it on a refused/failed transaction. Metadata admission alone is not a
physical filesystem reservation: staged/orphaned files require their own bounds
and crash cleanup. Database totals cannot prove external file contents match their
metadata without those integration checks.

## Verification and scope

Pure tests exercise lock order, tenant scoping, all-media aggregation, exact
integer handling, self-hosted behavior, quota refusal, callback rollback and
uncoordinated-delete refusal. Native interleavings and actual callback insertion
remain an integration gate before enabling hosted limits in each writer path.

The storage proof upgrade uses migration 0124. This helper does not independently
admit queued jobs or physical model calls; their dedicated admission policies
remain separate.

## Storage deletion accounting and operational limits

Deleting media removes library metadata immediately and retains its normalized
byte size in the durable cleanup proof. Pending, leased and `operator_action`
requests occupy the tenant's media quota until deletion is acknowledged. A retained
proof that still has matching live metadata is counted only once. Completed
proofs no longer occupy storage quota. Billing usage and resource admission use
the same authoritative aggregate; cleanup completion can reduce occupied bytes
while an insertion transaction runs, so insertion verifies the live-byte increase
separately rather than requiring pending cleanup totals to remain unchanged.

Historical incomplete proofs without byte sizes are not treated as zero. Hosted
media growth refuses until the operator reconciles them; Settings displays an
unknown media count with an explanation while preserving known subscription,
plan, other counters and billing-management actions. Unexpected database errors
remain errors. Deletion/cleanup, export and subscription management remain
available regardless of paid growth access.

This is metadata-backed tenant accounting, not a hard physical filesystem cap.
A process crash after writing a prepared UUID file and before committing its
metadata can leave a file without an asset or deletion-proof row. Normal refusal
cleanup handles returned errors; it cannot run after a process crash. Flat UUID
paths alone do not establish tenant ownership for those files. Operators must
monitor free disk space and use filesystem-level limits, and reconcile orphaned
files with all writers paused. Do not delete unreferenced files during active
writes: an in-flight upload or generation may legitimately be preparing one.
