# Back up and restore a Compose installation

Recovery snapshots contain Postgres **including pg-boss jobs**, the shared media
volume, the local `.env`, and resolved Compose configuration. Channel credentials,
AI keys and Telegram sessions in the database need the original encryption key
ring to be usable after recovery. The archived configuration contains those keys.

The tool uses Docker Compose, native `pg_dump`/transactional `pg_restore`, native
`tar`, and Node.js builtins. No database or archive format is reimplemented.
Requires Node.js 22+, Docker Compose v2, the standard named `media` volume and the
Compose `postgres`, `api`, `worker`, `web` service layout. Run from the installation
checkout; a native `init.sh` installation or externally managed database is not
supported by this tool. No Docker images are pulled by recovery intentionally;
the installation's Postgres image must already be available locally.

## Compose overrides and release images

Pass every Compose file used by the installation in its original order. For a
release-image deployment, recovery needs the base file and release overlay:

```sh
node scripts/recovery.mjs backup --project pubrick \
  --compose-file docker-compose.yml \
  --compose-file docker-compose.release.yml \
  --directory /secure-backups/pubrick-release
```

Use the same repeated `--compose-file` options with `restore`. Likewise pass both
`--file` options to every `docker compose` command below when using that overlay.
Recovery inherits additional Compose settings such as `COMPOSE_FILE` unless you
supply explicit files; explicit files are recommended for repeatable maintenance.
Backups inside the installation checkout are refused to keep plaintext credentials
out of Git and the Docker build context.

## Create a snapshot

Confirm the Compose project name with `docker compose ls`. Always specify it:

```sh
node scripts/recovery.mjs backup \
  --project pubrick \
  --directory /secure-backups/pubrick-2026-09-30
```

The destination parent must already exist. The destination itself must not exist.
The script stops running web, API and worker containers before dumping the database
and copying media, then restarts **only** the services that were running. Failed
backups also attempt to restart them. Check `docker compose --project-name pubrick
ps` after any failure; if restart fails, explicitly start the intended services.
A project-specific lock prevents overlapping recovery operations from this checkout.
Remove a stale `.recovery-PROJECT.lock` directory only after confirming no recovery
process remains.

This is a maintenance window. Do not write through native processes, other hosts,
database clients or other containers sharing these volumes while taking a snapshot.
The tool quiesces this Compose project's writers, not arbitrary external clients.
Allow in-flight operations to finish before starting maintenance. Stopping an
in-flight external publication can leave delivery uncertain; reconcile the platform
before retrying it. A backup cannot make an external platform transaction atomic.

A successful snapshot is atomically renamed into place only after all four payloads
and a complete SHA-256 manifest exist. Interrupted/failed work is never a completed
snapshot. Configuration changes detected during backup cause it to fail. Existing API/worker
containers must use the same encryption/auth keys and media volume as the current
Compose configuration; editing `.env` without recreating containers is refused. Database
and media bytes stream through file descriptors; the whole database is not loaded
into Node memory. Archive listing output has a 16 MiB limit and safely refuses a
larger listing on restore.

Snapshots use a `0700` directory and `0600` files. They contain **live secrets and
personal data in plaintext**. Store them on an encrypted filesystem or encrypt
with your organization's maintained backup tool before copying off-host. Never
commit snapshots, attach them to issues, or publish `compose.json`. Checksums detect
corruption; they do not authenticate a snapshot from an untrusted party. Protect
access, retention and off-host copies, and rehearse recovery periodically.

## Restore into a fresh target

Restore never replaces an existing installation. Use a fresh project/database and
empty media volume, preferably a separate host. Keep the same application release
and Postgres major version for the first boot; upgrading is a separate step.

1. Obtain the matching source checkout/images. Inspect the snapshot's resolved
   `compose.json` **locally** to reproduce any overrides or runtime configuration.
   Its environment is authoritative when shell variables overrode `.env` during
   backup. Do not paste this file into support conversations.
2. Copy `environment.env` to the target checkout's `.env` with private permissions.
   Preserve the complete `APP_ENCRYPTION_KEY` key ring and `BETTER_AUTH_SECRET`.
   Adjust origin and ports for the recovery host, not the secrets. Avoid conflicting
   exported environment variables; Compose gives them precedence over `.env`.
3. Start **only** the fresh project's Postgres, and create its empty media volume.
   For the default volume naming and project `pubrick-recovered`:

   ```sh
   docker compose --project-name pubrick-recovered up -d --wait postgres
   docker volume create pubrick-recovered_media
   node scripts/recovery.mjs restore \
     --project pubrick-recovered \
     --directory /secure-backups/pubrick-2026-09-30
   ```

   If Compose overrides the volume name, use that actual name. The script requires
   the volume to exist so a typo cannot silently create an empty backup source.
4. Restore checks every payload checksum, matching auth/encryption keys, no running
   application services, database emptiness, and media emptiness before import.
   It validates the Postgres archive and rejects media archives containing absolute
   paths, parent traversal, symlinks, hardlinks or special files. Database restore
   uses one transaction and fails on the first error.
5. **Web, API and worker remain stopped.** Start API and web explicitly after restore:

   ```sh
   docker compose --project-name pubrick-recovered up -d --wait api web
   ```

   Confirm login, organization isolation, drafts, uploaded images, credential tests
   and runtime origin before allowing normal users back in. API boot applies
   migrations; starting a newer release here is an upgrade, not a recovery rehearsal.
6. Inspect queued publications, active generation leases, pending paid calls,
   scheduled topics and enabled Autopilot/reply-analysis settings. Reconcile any
   uncertain external deliveries against the destination platform. Only then resume:

   ```sh
   docker compose --project-name pubrick-recovered up -d worker
   ```

   Restored jobs are preserved rather than silently discarded. Once started, the
   worker can retry jobs, make paid model calls and publish previously approved
   scheduled content. Restoring does **not** grant new human approval or disable the
   existing publishing gate. Ensure the original installation's worker remains
   stopped: two independently restored copies must never consume equivalent jobs
   against the same live platform credentials.

Media is extracted before the transactional database import. A failed import can
leave media in the disposable target. Keep application services stopped, discard
**only that disposable target's** volumes, recreate them and retry after resolving
the error. There is deliberately no automatic deletion or overwrite of a target.
An interrupted restore is not resumable; the emptiness checks reject partial data.

## Test the recovery tooling

The normal script suite runs orchestration tests without Docker. The explicit
integration test uses uniquely named disposable Compose projects, exercises native
Postgres (including a queued job), media and secret-file recovery, and removes only
its own containers and volumes:

```sh
node --test scripts/recovery.test.mjs
PUBRICK_RECOVERY_DOCKER_TEST=1 node --test scripts/recovery.integration.test.mjs
```

The integration tier is opt-in; it does not inspect or stop the developer's running
Pubrick installation. A real installation rehearsal should additionally verify
login/decryption, application migrations and external delivery reconciliation.
