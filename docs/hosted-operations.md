# Hosted operator checks

This guide covers the current sandbox BYOK implementation. It does not establish
live payment availability, deliverability, production capacity or a commercial
support/retention policy. Configure those launch inputs separately.

## Inspect a selected installation

From the matching release checkout, with its private `.env`:

```sh
pnpm ops:status --project pubrick-beta --checkout /srv/pubrick
```

For release-image deployments, provide the same ordered Compose files used to
start that project:

```sh
pnpm ops:status --project pubrick-beta --checkout /srv/pubrick \
  --file docker-compose.yml --file docker-compose.release.yml
```

The project and absolute checkout are mandatory. The command attests Compose
container labels (project, service, working directory and configuration files),
compares configured and existing API/worker billing identities and database
targets (without comparing passwords), and requires one running Postgres
container. The selected Compose database service must be `postgres:5432`;
external databases are refused. Overlay order is significant. It never starts, stops, recreates or repairs a service. It
uses Docker Compose and maintained `psql`, with a read-only database transaction,
5-second statement/1-second lock timeouts, a 15-second subprocess deadline and
bounded output. Missing tables, invalid results, unavailable Docker/database or
mismatched identity refuse inspection; they are not reported as zero counts.
Docker and database stderr, interpolated configuration, account IDs, tenant IDs,
mail payloads, signed links and raw error messages are not printed.

The JSON report includes service-container counts and observed durable facts:

- `mail` and `mail.deadletter`: authentication queue states. Counts exclude other
  mail/notification channels. A completed job can also mean skipped delivery;
  it does not prove a recipient received a message.
- `billing.*`: checkout, receipt and external cleanup states, due subscriptions,
  and live/expired mutation leases. `configured` matches the configured sandbox
  provider/account; `other_identity` requires separate restore/operator review.
  Self-hosted retained billing rows use `retained`, not an active billing claim.
- `media.cleanup`: pending/completed/terminal proofs. `media.unknown_size` counts
  uncompleted unknown-size proofs without matching positive live metadata.
- `ai.leases`: dispatch-live, settlement-grace and expired physical-call fences.
  A fence is not a provider response, usage estimate or a completed job.

`count`, `attempts` and `due_seconds` are exact decimal strings; `attempts: null`
means that metric has no attempt counter. Ages are computed with the database
clock. Empty groups have no row. Due ages do not automatically define an outage:
retry/backoff, active leases and bounded schedulers legitimately retain work.
No unconfigured alert thresholds, invented cost figures or readiness verdicts
are produced. This is a snapshot, not a transactional prediction of the next
request; configured runtime state can change after inspection.

`GET /api/health` is process liveness and version only. A running container or
successful status query does not prove SMTP, vendor API reachability, current
worker registration, file-volume availability or end-user readiness. Inspect
local sanitized logs and use the documented acceptance/recovery checks.

## Respond to retained work

1. For authentication mail failures, repair SMTP and have the user request a
   fresh verification/recovery/invitation link. Never decrypt jobs into support
   logs or automatically resend dead letters; see [identity operations](hosted-identity.md).
2. For billing `operator_action` or `other_identity`, inspect the configured
   account/environment and provider obligations through the authorized operator
   account. Do not reset keys, blindly requeue creation or grant access from a
   returned checkout URL; see [billing orchestration](../apps/api/src/billing/README.md).
3. For media terminal/unknown proofs, inspect the exact shared mount and ownership
   during maintenance. Preserve the immutable org/kind proof, size and fence;
   follow [media cleanup and occupancy](media-cleanup.md). This command neither
   requeues requests nor scans/deletes orphan files.
4. For physical-call fences, check dispatch deadlines and settlement grace before
   treating them as stale. Never clear leases to bypass a concurrency refusal;
   remote calls may still be settling. See [job admission](hosted-job-admission.md).

## Backup and recovery

Use the same project, checkout, `.env` and Compose overlay as the running release.
Store snapshots outside the checkout on operator-protected encrypted storage.
A backup contains plaintext secrets and personal data; do not attach it to an
issue or publish resolved Compose configuration.

```sh
node scripts/recovery.mjs backup --project pubrick-beta \
  --compose-file docker-compose.yml --compose-file docker-compose.release.yml \
  --directory /secure-backups/pubrick-beta-2026-09-30
```

The tool quiesces the selected project's writers, captures matching database,
media and effective configuration, and resumes the services it stopped. Restore
only into a fresh target, preserving key history and the release/Postgres major;
restored writers remain stopped until explicit operator review/resume. Follow
[the complete backup/restore procedure](backup-restore.md), including matching
Compose files, billing account/origin review, retained mail, cleanup proofs and
checksums. Run status from that target checkout before resuming writers. Never
use a restore rehearsal against an installation containing user data.

## Local checks

```sh
node --test scripts/hosted-status.test.mjs
PUBRICK_STATUS_TEST_DOCKER=1 node --test scripts/hosted-status.integration.test.mjs
```

Native acceptance additionally uses disposable Postgres with the real migration
inventory and pg-boss schema; no SMTP, payment, model or normal developer stack is
needed. The status command has no public HTTP endpoint.
