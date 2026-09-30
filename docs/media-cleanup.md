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
bindings. It also renames five existing billing/physical-call CHECK constraints to
canonical names with `ALTER TABLE … RENAME CONSTRAINT`. Their predicates and
validated status remain unchanged; no table scan or later validation is needed.

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

## Storage occupancy and migration 0124

Hosted storage admission counts live media bytes **plus** the byte sizes retained
by pending and `operator_action` deletion proofs. Deleting metadata does not free
storage: only a successful physical unlink (or target `ENOENT` on a verified,
accessible storage root) followed by the fenced completed acknowledgement does.
An API fast-path unlink therefore conservatively retains occupancy until the
worker confirms it. Completed proofs consume no quota. A restored live UUID
with the same organization and kind is counted once, from its live metadata.

Migration 0124 adds a nullable positive `bigint` byte size and an organization
index to retained proofs. New transactional staging copies the actual normalized
asset size. Older proofs remain unknown; this migration does not invent sizes,
scan the filesystem, or run an unbounded historical backfill. Matching live
metadata already supplies their occupancy, and re-staging that owned live asset
records its size. Unmatched unknown proofs, or nonpositive live metadata, refuse
hosted media growth with `storage_reconciliation_required`. Self-hosted growth
keeps its existing behavior. Other resources and deletion remain available.

Restore or upgrade operators should let pending cleanup finish on the correctly
mounted volume first. For terminal unknown requests, stop API and workers, verify
the ownership proof and canonical UUID/kind path against the shared volume, and
measure the existing file before assigning its positive size to that **same**
proof. Never infer zero from a missing or inaccessible storage root, assign an
estimated size, change ownership, or delete a pending proof to free quota.
Requeue repaired terminal requests with a cleared lease/token and reset attempts;
normal cleanup then records completion. Restart workers after review. The new
positive CHECK is `NOT VALID` to avoid scanning the historical queue on startup;
it checks new writes immediately. An operator can later run
`ALTER TABLE media_cleanup_work VALIDATE CONSTRAINT media_cleanup_work_byte_size_check;`.
NULL represents unknown and remains allowed after validation.

Quota admission uses total retained occupancy, while exact insertion-delta checks
compare live metadata only. A concurrent cleanup acknowledgement can reduce
retained bytes without falsely rejecting a valid normalized insertion. No database
locks are held for file deletion or operator size inspection.

This accounting covers committed media and durable deletion proofs. A process
crash after preparing a file but before committing its asset row can still leave
an unowned flat-UUID file; it has no recoverable tenant proof. This is not a hard
filesystem capacity guarantee or an automatic orphan sweep. Operators must
monitor disk capacity and reconcile those files during a stopped-instance audit.
