# Telegram draft decision foundation

Scope: additive storage and strict contracts for design
[0013](../specs/0013-telegram-draft-decisions.md), plus reuse of the existing
editorial snapshot and rejection transaction. This is not an available
Telegram user workflow. No webhook, account-binding endpoint, callback handler,
notification callback or settings control is enabled by this change.

## Storage and domain boundaries

Migration 0128 adds nine tables: a global inbound bot registry, immutable
physical mutation attempts, encrypted tenant setup configuration, binding
challenges, private bindings, initial capabilities, actor confirmations,
replay receipts and minimal decision audit. No existing content row is rewritten.
Time columns use `timestamptz`; the historical migration inventory explicitly
includes the 22 new columns.

Each physical install/delete attempt keeps its own outcome. A successful exact
retry cannot erase an older unknown request. A deleted organization's registry
remains disabled and quarantined after tenant secrets and personal bindings
are removed. The initial storage policy also refuses organization-to-organization
ownership transfer, including after removal of the tenant configuration.

Actor rows have direct organization/user cascades. Replay and applied editorial
evidence survive user deletion until organization deletion. Audit and replay
rows cannot be rewritten; only replay retention and tenant erasure remove them
through their documented paths. Resource references in capability/audit records
are deliberately opaque rather than nested deletion FKs. Future writers must
verify current scope and authority under the locks in the design.

Shared DTOs publish admission and retention bounds, but this foundation does
not implement the admission counters or retention janitor. No elapsed time or
lease can release remote mutation quarantine.

The common editorial reader/hash preserves the previous client-review
serialization, ordering, effective adaptation body and optional media keys.
Fixed legacy hash receipts cover text, inline-image revision, video, and their
combination. The helper does not acquire locks or grant authority.
`ContentRepository.rejectInTx` preserves the existing rejection mutation;
the web method retains its organization transaction and result read. A future
Telegram caller must authorize its actor and lock the domain before entering
the shared mutation, and commit capability consumption and audit in that same
transaction.

Workspace exports include an explicit minimal editorial audit projection.
Bot ownership, mutation attempts, secrets, personal identity, private chat,
capabilities and update replay data are deliberately excluded.

## Failure and review closure

The first native application failed before any case ran: generated SQL created
a composite configuration FK before its required owner/identity unique index.
The unapplied migration was regenerated from a source-level inline UNIQUE
constraint with installed Drizzle tooling. Generated metadata was not hand-edited.

Independent migration review also found a missing registry/physical-attempt
identity check and unsafe owner reassignment after configuration removal.
Both guards were strengthened and covered by native assertions. The final
source review found no blocking migration defect. Installing additive FKs and
parent-delete triggers can briefly wait on parent-table writes.

Independent API source review found no semantic regression in snapshot,
rejection or export-policy extraction. Native evidence is recorded separately
from that source review.

## Native foundation acceptance

A fresh disposable PostgreSQL fixture applied the complete migration journal
and passed six cases: invalid cross-organization references and malformed
identity/confirmation shapes; prohibited owner transfer/release; direct user
erasure with preserved minimal audit; unique immutable update receipts; complete
tenant erasure preserving unknown physical attempts; and overlapping raw user
and organization deletes in both orders with actual lock-wait observations.

PostgreSQL image:
`pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b`.
The successful native closure took 7.18 seconds. The initial failure and closure
logs are preserved separately under the operator's local validation backup.

The affected API tier passed 283 cases across client approval links, existing
content operations, manual publication handling, prompt decisions, fixed snapshot
hashes and export policy. This includes the existing web rejection behavior;
it does not prove a Telegram callback that has not been implemented.
Workspace typecheck passed 20 tasks, shared/database package builds passed,
the Nest API build passed, Biome checked 1,078 files and root scripts passed 53 cases with three documented
opt-in skips. These are separate local gates, not a fresh full monorepo suite.

The full database tier ran on pinned Linux Node 22 and the same PostgreSQL
image. It passed 269 of 272 actual cases on the initial integrated run. All
128 journal cutpoints reached the expected zoned-column inventory (87.147
seconds). That is a timestamp-column inventory proof, not equivalence of all
arbitrary schema/data states.

Three failures were closed without repeating unaffected database cases: the
historical CHECK inventory lacked the 35 new Telegram constraints, and two
source-guard cases correctly rejected AppleDouble `._*` metadata injected by
macOS tar packaging into the owned Linux fixture. The exact late-table CHECK
names were added to `NON_ENUM_CHECKS`; the historical seed/enum loop and count
assertion remain unchanged. Only generated metadata files inside the owned
disposable fixture were removed. The native populated migration case then
passed, and all eight unchanged source-guard cases passed. The original log
also records 32 failed metadata pseudo-suites; they are not source tests and
are not counted as passed cases. This provides composite acceptance of 272
distinct database cases, not an all-green first integrated command. Preserve
the initial and closure logs separately.

## Remaining acceptance

The backend slice still needs two-phase identity binding, bounded authenticated
updates, current actor/brand authority, fresh unsent-draft checks, one-shot
private confirmation and atomic rejection/replay. Race checks involving those
writers and their retention janitor must run when those writers exist.
Settings and notification controls require the later scripted compiled browser
journey. No live Telegram, Google, publication, generation or payment call was
made for this foundation.
