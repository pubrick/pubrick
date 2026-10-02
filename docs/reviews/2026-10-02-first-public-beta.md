# First public OSS beta verification

Date: 2026-10-02.

## Published identity

- Release: [`v0.1.0-beta.1`](https://github.com/pubrick/pubrick/releases/tag/v0.1.0-beta.1),
  published as a prerelease at 08:13:29 UTC.
- Reviewed source/tag target: `e394ec7c6044a39f3a9e7726d58c6c85eea92099`.
- [PR #157](https://github.com/pubrick/pubrick/pull/157) merged at
  `8db1a675ed25cfe08cc28443631416f6284d959c`; its tree matches the reviewed source.
- [Final-source CI](https://github.com/pubrick/pubrick/actions/runs/36949302127)
  passed builds, typechecks, lint and 5,195 assertions. The
  [main merge CI](https://github.com/pubrick/pubrick/actions/runs/36977852683)
  also passed.
- The owner authorized the exact source merge, version publication and one
  manual [Release images run](https://github.com/pubrick/pubrick/actions/runs/36977956036).
  All API, worker and web image jobs succeeded for Linux AMD64 and ARM64.

The release assets record immutable image digests, full source identity and both
platforms. All three packages are public. Anonymous downloads of
`release-images.env`, `release-manifest.json` and `release-acceptance.json` matched
the reviewed local bytes and GitHub asset SHA-256 digests. The maintained
offline asset validator passed again on those anonymous downloads. The remote
annotated tag still resolves to the reviewed source.

Use the public [sanitized acceptance receipt](https://github.com/pubrick/pubrick/releases/download/v0.1.0-beta.1/release-acceptance.json)
for exact index and runtime manifest digests. Private fixture credentials,
database fingerprints, account details and host paths were excluded.

## Runtime acceptance

Actual public source files were compared against every Git blob and executable
or symlink mode at the reviewed commit. Disposable stacks used the unchanged
base/release Compose files, explicit platforms, isolated ports and named volumes,
synthetic credentials, and a fresh Docker configuration without registry
credentials, credential helpers or inherited proxy/token environment.

| Runtime | Completed scope |
| --- | --- |
| Linux AMD64 under Docker Desktop emulation on ARM64 | Anonymous digest pulls, fresh installation, maintained browser journey, backup and independent recovery |
| Native Linux ARM64 Docker runtime | Anonymous digest pulls, fresh installation, maintained browser journey, backup and independent recovery |
| Native ARM64 coherent source-built predecessor | Real upgrade from `0a33b9c28906df480710ea8d1e36eac05c52b126` to the public digest set, then backup and independent recovery |

All three services' running source, version and architecture were checked. The
registry index bytes matched the pinned digest; the selected platform manifest
was linked to that index. Docker 29 reports index and platform identities
separately, so the private harness records them separately. The predecessor's
recorded local image references were preserved and verified through native
immutable-hash lookups; no image was relabeled to manufacture an upgrade.

The maintained browser journey exercised account/workspace creation, brand and
manual-channel setup, content editing with persisted changes, an actual workspace
export and UI tenant switching. Recovery used the maintained CLI through a real
symlink from a disposable working directory. Fresh restored login, content,
export, tenant switching, stable database fingerprint, exact media bytes and the
matching auth/encryption environment passed.

The upgrade replaced all three actual container and runtime image identities
while retaining the same project, volumes, database cluster and key ring. The old
worker stopped before the new API. Accounts, content, tenant separation and media
survived. Source writers stopped before recovery; restored workers never started.
Each fixture had zero model usage and publication records. All exact owned
containers, networks, data volumes and synthetic runtime files were removed
before success receipts were finalized.

## Limits and follow-up

- This is the first published version. The upgrade used a coherent source-built
  pre-release, with no database-source diff. It does not establish compatibility
  with an earlier published release or exercise a new schema migration.
- AMD64 used emulation. These journeys do not establish physical x86 performance,
  production capacity, cryptographic attestation verification or live vendor
  availability.
- One initial AMD64 recovery attempt returned a redacted Docker compose error.
  A complete fresh repeat with private Docker stderr observation passed without
  application changes or Docker errors. The cause is unconfirmed and tracked for
  investigation. Failed evidence was retained; no success was recorded for the
  failed attempt, and its fixtures were removed.
- External SaaS deployment awaits the owner's domain and SSH target. Payments
  remain deferred. No live paid service or payment settlement is announced.
- Controlled live Telegram decision sandbox verification remains pending.

The tag and versioned image set are immutable. Future source fixes and release
checks belong to a new reviewed commit/version.
