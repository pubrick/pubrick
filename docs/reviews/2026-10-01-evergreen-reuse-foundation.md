# Evergreen reuse foundation

Date: 2026-10-01. Source: `d15516fb` and `d70276cc` on
`codex/evergreen-draft-reuse`, based on verified weekly candidate `b4ab01db`.
Status: contracts and storage verified; admission, retry, source deletion and
user interface remain implementation work. No released feature claim.

## Scope

Strict shared contracts cover saved-source preview/digest, one-run paid consent,
retry acknowledgement, bounded normalized material and permission-safe source
attribution. Ordinary RunCreate and existing detail responses were not broadened.
The origin declaration was extracted and reexported without changing its values,
so future attribution imports cannot form a content/run DTO cycle.

Migration `0127` adds tenant/brand-scoped operation audit and run-keyed lineage.
Source, request target and result UUIDs are separate durable audit values.
Operation audit contains no raw body/title or source digest snapshot. Consent
actors are opaque bounded text. Lineage source UUIDs have no content deletion FK;
one-way terminal redaction clears frozen title/digest/origin without permitting
restoration. Raw source material belongs in run input, whose deletion integration
is still pending. No legacy source is assigned fabricated internal lineage.

The additive scoped run unique index precedes its composite lineage FK. Its
ordinary index build blocks run writers during the migration transaction; the
existing UUID primary key already guarantees tuple uniqueness. No destructive
DDL, source cascade, DELETE trigger or backfill was introduced. Explicit export
allowlists cover the new audit/lineage fields under existing manager authority.
The 10,000-operation admission cap is a declared contract; its transactional
enforcement remains backend work.

## Evidence

- Shared contracts and affected existing schemas: **117/117**.
- Native foundation, schema and timestamp tier: **36/36**, zero skips (eight
  foundation, 20 schema and eight timestamp cases).
- Focused migration inventory: **3/3**, 54 intentionally filtered; exact
  **248 CHECKs**, **182 zoned columns** and **127 ordered journal entries**.
  This does not rerun the full historical-prefix matrix.
- Export policy: **3/3**. Shared/database/API typechecks, scoped Biome and diff
  checks passed. The API dependency build passed **7/7** tasks, two cached;
  no API/web runtime build or browser acceptance was claimed.
- Independent migration source review passed before committing DDL. Follow-up
  native proof review required exact trigger messages where other constraints
  could also refuse an update, and complete otherwise-valid atomic unredaction.
  Those proof gaps were corrected and independently closed.

Initial fixture setup lacked the existing external-source review marker and
did not execute its eight native cases. An explicit timestamp inventory also
omitted three new columns. Both corrections preceded the green native result.
The fresh checkout's API typecheck initially lacked compiled dependency outputs;
the bounded dependency build and affected typecheck then passed. These failures
are not counted as acceptance.

Reports are retained locally at `/tmp/pubrick-reuse-foundation-native-final.json`,
`/tmp/pubrick-reuse-migration-inventory.json` and
`/tmp/pubrick-reuse-export-policy.json`. Fixtures used synthetic content/secrets
on owned PostgreSQL 16.15 tmpfs storage. All fixture databases, container and
storage were removed; no provider or publication call occurred.

## Remaining acceptance

Fresh session/brand authority, operation-first replay after target deletion,
atomic non-null enqueue, source revision/title/body CAS, retry fencing, complete
run-input/checkpoint erasure, fresh human-review provenance and the built browser
journey remain steps 2–5 of the reviewed execution plan. Schema checks alone do
not establish those runtime guarantees.
