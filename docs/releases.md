# Versioned image releases

Pubrick supports two deployment paths:

- `docker-compose.yml` builds API, worker and web from a local source checkout.
- Adding `docker-compose.release.yml` deploys published images and removes every
  local build definition. Docker Compose **2.24.4 or newer** is required for the
  overlay's `!reset` directive.

Image publication is not automatic. The release workflow runs only when a
maintainer explicitly dispatches it from `main`; a merge or tag alone does not
spend build minutes or publish packages. This workflow is release tooling, not
proof that a particular version has already been published.

## Operator installation

Download the source archive for the chosen published release (or check out its
exact tag), including both Compose files and `.env.example`. Copy `.env.example`
to `.env`, configure the database password, independently generated auth and
credential encryption secrets, public origin and ports as described in
[self-hosting](self-hosting.md). Download `release-images.env` and
`release-manifest.json` from the same GitHub release.

Copy the three `PUBRICK_*_IMAGE` assignments from `release-images.env` into `.env`.
They reference multi-platform manifest **digests**, so later registry tag changes
cannot silently change this installation. All three must come from one release.
The JSON manifest records each image digest, version, exact source SHA and both
supported platforms (`linux/amd64`, `linux/arm64`). Do not replace these references
with `latest` or combine different release versions.

```sh
docker compose -f docker-compose.yml -f docker-compose.release.yml config --quiet
docker compose -f docker-compose.yml -f docker-compose.release.yml pull
docker compose -f docker-compose.yml -f docker-compose.release.yml up -d --no-build
docker compose -f docker-compose.yml -f docker-compose.release.yml ps
```

Use **both files for every command**, including logs, backups and shutdown. They
retain the default project and volume names, environment, API migration startup,
health checks, media sharing and dependency ordering. If an existing deployment
uses `--project-name`, preserve it too; changing project names selects different
volumes. The overlay does not provision TLS or change registration policy. PostgreSQL is
pinned to the same PostgreSQL 16/pgvector multi-platform digest used by database
CI. Existing `pgdata` must already be PostgreSQL 16-compatible; switching this
image is not a major-version database upgrade or a data conversion. For another
PostgreSQL major, use a separately planned dump/restore migration.
Avoid printing the full rendered Compose configuration: it contains secrets.

New GHCR packages can initially be private. Maintainers must set all three
packages' visibility to public before announcing a release intended for anonymous
pulls. If pulling fails with an authorization error, confirm package visibility
rather than editing credentials or building an unrelated local checkout.

Source-to-image linkage is reproducible; byte-for-byte rebuilding is not promised.
The existing Dockerfiles use moving Node base tags, so a later rebuild can produce
different bytes even with the same application source. The published digests are
the installation identity.

## Maintainer release procedure

1. Integrate the coherent release candidate, run the complete local quality gate,
   review changes and record the exact reviewed `main` commit. Keep release notes
   about user-visible changes, migration requirements and known limits.
2. With the owner's explicit publication authorization, create a version tag such
   as `v0.1.0` or `v0.1.0-beta.1` pointing at that exact commit. Never move a
   published tag. The workflow requires an existing tag and does not create one.
3. Explicitly dispatch **Release images** from `main`, supplying that tag and its
   full lowercase 40-character commit SHA. Dispatching consumes Actions minutes;
   do not use it as an iteration loop or testing substitute.
4. Validation rejects malformed inputs, mismatched tag/commit pairs and commits
   outside `origin/main`. It reserves a **draft GitHub release** before building.
   An existing release causes failure instead of overwriting that version.
5. All three images build from that SHA with the existing Dockerfiles, on AMD64
   and ARM64, with OCI source/revision/version labels, BuildKit provenance and
   SBOM attestations. Maintained Docker/GitHub actions are pinned to full commit
   SHAs. Only image jobs can write packages; only draft/manifest jobs can write
   GitHub releases. No job deploys a running instance or writes `main`.
6. The final job attaches `release-images.env` and `release-manifest.json` to the
   draft only after all images succeed. Review those assets, set package visibility
   and test a disposable install, upgrade and restore using the exact digest
   references. Confirm both architectures before claiming both were tested.
7. Add the reviewed release notes and publish the draft as a separate deliberate
   action. A draft with images is not yet an announced, verified release.

### Failed or interrupted publication

Registry publication is not transactional: one image may be pushed before another
fails. The release remains a draft and the complete manifest is absent. Do not
announce it or use the partial images for an upgrade. The workflow intentionally
refuses to rerun against an existing draft, so a retry cannot silently replace a
version's image bytes. Prefer a new version/tag; removing a failed draft and its
partial package versions is a separate maintainer cleanup decision, never an
automatic workflow step. GitHub/package administrators can still change registry
tags, which is why installations pin the recorded digests.

## Upgrade and recovery

Back up the database, media volume and environment/encryption key ring together
before upgrading. Follow [self-hosting](self-hosting.md)'s upgrade procedure. Stop
the old worker before starting the new API: the API applies migrations at boot;
the new worker waits for API health. Update **all three** image references and the
Compose files from the same release, then start the full stack with the overlay.

A previous image digest alone is not a rollback plan. New database migrations can
make an older image incompatible. Restore the matching pre-upgrade database,
media and key-ring backup into a disposable stack first, verify it, and then use
that recovery procedure if a production restore is necessary.
