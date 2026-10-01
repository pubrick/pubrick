# Evergreen reuse backend milestone

Date: 2026-10-01. Candidate: `e25b88c0`, pushed on
`codex/evergreen-draft-reuse`. Design:
[0012](../specs/0012-evergreen-draft-reuse.md). Tracking: `Ozon-tools-3xwei`.

This record covers the session backend after the
[shared/database foundation](2026-10-01-evergreen-reuse-foundation.md).
UI, integrated workspace verification, selected native guard proofs and built
browser acceptance are still pending. No main integration, provider call or
publication is claimed.

## Implemented boundary

- Read-only saved-source preview and strict, explicitly consented session reuse.
  API-key actors acquire no internal reuse or retry capability.
- Organization/operation/key replay resolves the immutable request target and
  recorded brand before current resource existence. Fresh session and brand
  authority still precede replay; missing results return 410 without new work.
- Stable SHA-256 identities use the existing `safe-stable-stringify` dependency
  and shared parsed contracts. Source identity binds exact nullable title,
  revision and normalized material; request identity binds version, operation,
  target kind/UUID and DTO. Valid UUID casing preserves target identity.
- Fresh admission checks capacity, existing AI/quota selection and final source
  evidence under canonical locks. Run, lineage, operation and a non-null job
  commit together. Queue payload remains the existing ID-only transport shape.
- Internal retry retains accepted material/instructions and lineage under new
  paid consent. Ordinary bodyless retry retains its existing execution path.
- Deletion locks the sorted direct/reuse/retry run union under the strong brand
  serialization lock. Live reused runs refuse deletion with up to 20 scoped
  receipt IDs. Terminal input, steps, guidance/template snapshots and errors are
  erased; one-way lineage tombstones clear frozen title/digest/origin.
- Independent output drafts and versions, usage and operation audit remain.
  Unavailable or erased source detail suppresses raw snapshots and source links;
  actorless/API-key projections do not disclose retained material.
- All six new refusal codes have actionable English, Spanish, Portuguese and
  Russian messages and a complete closed error mapping.

## Focused evidence

These are affected tiers, not a full workspace run:

- Admission/identity/guard/authority tier: 36 passing cases across five files,
  including 13 native admission cases. The native tests use a generated owned
  database; no production worker/provider runs.
- Final affected closure: eight identity cases plus one concurrent admission
  case passed; 12 admission cases were intentionally filtered after their prior
  passing run. Final API types, scoped Biome and diff checks passed.
- Deletion/projection tier: all six initial regression cases failed against the
  callback-only baseline; all seven passed after implementation, including an
  actual observed brand-lock wait. Source-only and independent output/ledger
  assertions cover terminal direct, reuse and retry snapshots.
- Source CAS fixture observes a real `FOR SHARE` wait before refusal and rollback.
  Concurrent same-key admission yields one durable run/job; replay after source
  or AI removal, operation capacity, revoked grant/session, missing result and
  actual queue null/throw boundaries are covered.
- Identity units include independently computed source/retry envelope vectors.
  UUID-case regression failed alone before normalization (seven pass, one fail)
  and all eight passed afterward.
- Exhaustive web error-contract and locale-parity tier: 61 cases passed across
  two files; scoped lint passed. This verifies messages, not the compose flow.
- Independent source review found no remaining backend blocker after closing
  the bounded active-run recovery IDs and explicit lineage projection findings.
  This source review does not establish every race predicate as mutation pinned.

Retained evidence includes `pubrick-reuse-admission-final`,
`pubrick-reuse-admission-closure`, `pubrick-reuse-erasure-red`,
`pubrick-reuse-erasure-final-native`, `pubrick-reuse-hash-uuid-red`,
`pubrick-reuse-hash-uuid-green` and `pubrick-reuse-error-locales` logs/reports in
the local temporary evidence directory. Initial invalid `post` content-type and
queue payload `id` assumptions were corrected to existing `social_post` and
`runId` contracts; no production contract was changed to fit those fixtures.

Owned generated fixture databases were removed and their absence verified.
The synthetic PostgreSQL container was handed to the independent proof owner;
its eventual removal remains that owner's cleanup task. User runtime data,
credentials and private backups were not fixture targets.

## Remaining acceptance

Complete the existing compose/content/receipt/queue workflow, explicit paid
confirmation, stable replay after uncertain outcomes and unsaved-source handling.
Run the coherent integration gate and production browser journey without
publication. Independently verify selected critical CAS, deletion serialization
and checkpoint-erasure guard proofs using the documented three-run protocol;
retain inconclusive host failures honestly. Update user availability claims only
after that evidence, and obtain exact-head release authorization separately.
