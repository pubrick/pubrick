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
   `media_assets.byte_size` across every brand and media kind.
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
to the same media sum. There is no resettable counter or backfill dependency.

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

Current callsites requiring integration:

- API `brands/brands.repository.ts:create` and
  `channels/channels.repository.ts:create` currently insert without a shared
  admission transaction. Channel brand ownership must be rechecked inside it.
- API `media/media.repository.ts:uploadImage/uploadVideo` and worker
  `generate/generate.repository.ts:saveGeneratedImage` currently write their
  bounded normalized file first and then insert metadata. Wrap metadata insertion
  and preserve file cleanup on every rollback or quota refusal.
- API `content/content-images.repository.ts:crop` currently takes organization
  `KEY SHARE`, content-item and media locks before decoding/writing its file.
  Acquire the shared advisory at transaction entry before those locks; bounded
  decoding/file preparation must move outside the locked transaction, followed
  by authoritative revision/ownership revalidation and same-transaction insertion.

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

This helper has no migration, no durable concurrent-job reservations and no LLM
cost admission. It does not claim these independent limits are covered.
