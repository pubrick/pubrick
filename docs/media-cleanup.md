# Durable media deletion

Media metadata and physical JPEG/MP4 files are separate resources. Every deletion
that removes library assets must call `stageMediaCleanup(orgId, tx, scope)` before
its database cascade, in the **same transaction** and under its existing deletion
locks. The staging query reads tenant-qualified metadata directly with
`INSERT SELECT`; it performs no disk I/O and never loads a whole workspace's
asset list. Scope may be one brand or at most 1,000 explicit asset UUIDs.

The `media_cleanup_work` table deliberately has no organization foreign key. Its
UUID, organization ID and media kind preserve deletion ownership after the parent
row disappears. A rollback removes the cleanup request with the domain write.
An existing proof for another organization or kind refuses staging. Re-staging
an owned UUID that exists in restored metadata resets its attempts and lease;
this does not authorize reuse of application-generated UUIDs for new assets.

## Worker protocol

The worker polls at most 25 due rows per tick with `FOR UPDATE SKIP LOCKED`.
It commits a random lease token and a 60-second lease **before** filesystem work.
A still-live asset is never unlinked: its request becomes `operator_action` with
`asset_exists`. After crashes, an expired lease can be claimed again. Each claim
consumes one of eight attempts, including crashes, so repeated failures stop
with an actionable durable row instead of looping forever.

Only canonical lowercase UUID basenames are accepted: `.jpg` for images and
`.mp4` for videos, directly within `MEDIA_STORAGE_DIR`. A configured final
directory symlink is refused. Normal parent aliases are resolved with `realpath`.
An asset symlink is unlinked itself, without following its target. API and all
worker replicas must mount **the same media volume at their configured path**;
cleanup is not a remote object-storage adapter.

A missing target (`ENOENT` from `unlink`) completes idempotently. A missing or
inaccessible storage root retries as `storage_unavailable`; it does not prove
that a target has been deleted. Other disk failures use bounded exponential
backoff (10 seconds initially, up to one hour) and become `operator_action` after
eight claims. Unsafe paths stop immediately. Logs contain closed error codes,
not raw filenames, filesystem messages or tenant data.

Acknowledgements match the UUID and current lease token. An expired worker may
finish an already admitted unlink, but cannot overwrite a new claim's status.
Duplicate unlink is safe because asset paths are immutable. No database locks
remain held while a filesystem operation runs.

Completed proofs are pruned in batches of 25 after seven days. Pending and
`operator_action` proofs are retained. Operators must monitor terminal requests,
fix the mount/permissions or investigate `asset_exists`, and requeue a verified
request only when its asset metadata is absent. Clearing leases and resetting
attempts issues a new fenced attempt; never change its organization/kind proof.

## Restore and rollout

Apply migration 0123 before enabling the worker module and transactional deletion
bindings. It also gives five existing billing/physical-call CHECK constraints
canonical names, retaining exactly their old predicates. Replacement uses
`NOT VALID` to avoid scanning populated billing history under the startup lock;
new writes are checked immediately. Operators may subsequently validate each
named constraint during a maintenance window with `ALTER TABLE … VALIDATE
CONSTRAINT …` (checkout status, receipt kind/status, subscription status and
physical-call kind). Their unchanged predicates already guarded existing rows.

```sql
ALTER TABLE billing_checkout_attempts VALIDATE CONSTRAINT billing_checkout_attempts_status_check;
ALTER TABLE billing_receipts VALIDATE CONSTRAINT billing_receipts_kind_check;
ALTER TABLE billing_receipts VALIDATE CONSTRAINT billing_receipts_status_check;
ALTER TABLE billing_subscriptions VALIDATE CONSTRAINT billing_subscriptions_status_check;
ALTER TABLE hosted_ai_call_leases VALIDATE CONSTRAINT hosted_ai_call_leases_kind_check;
```
 API fast-path unlink may remain: the durable worker then sees `ENOENT`
and completes the same request. Billing expiry never blocks deletion or cleanup.

Stop API and workers before restoring database and media snapshots, as required
by the release restore guide. A live restore raced with a previously admitted
unlink is unsupported. Restore both resources from the same snapshot; verify
mounts and pending cleanup proofs before restarting workers. The live-asset
check protects restored metadata from queued stale requests.

Filesystem tests use private directories. Native tests use disposable
PostgreSQL databases and prove transactional rollback, cascade survival,
concurrent leases, stale acknowledgements, restored re-staging, bounded failure,
active-asset refusal and retention. Deployment is complete only once the worker
poller and every resource/workspace deletion path are wired to this protocol.

## Application lifecycle

Workspace, brand and individual media deletion stage ownership proofs in the same database transaction before deleting metadata. A rollback preserves both metadata and files and rolls back the cleanup proof. API responses complete after the database commit; filesystem deletion is asynchronous and does not turn a successful deletion into a retry. Individual attachment conflicts remain authoritative foreign-key refusals.

The worker performs one nonoverlapping batch at startup and every 10 seconds. Shutdown stops new polls and awaits the active batch. Failed polls log only a closed error code. API and worker must share `MEDIA_STORAGE_DIR` and the same filesystem: Compose already binds both to `/data/media` on the shared media volume. Native development defaults to `.data/media` under each process working directory; when running API and worker from different directories, configure the same absolute path for both. Pending cleanup is operational data excluded from workspace downloads; full instance recovery retains it with the database, and restored workers remain stopped until operator review.
