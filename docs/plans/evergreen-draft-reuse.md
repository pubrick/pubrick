# Evergreen draft reuse execution plan

Status: PROPOSED; implementation blocked on independent design review, not on
operator setup. No implementation or release claim.
Date: 2026-10-01.
Design: [0012](../specs/0012-evergreen-draft-reuse.md).
Source baseline: `81b346fb` (main); separate from the weekly-plan release.
Tracking: `Ozon-tools-44lpl` (root owns status updates).

## Delivery boundary

One manually confirmed reuse of a saved master within its brand creates one
new reviewable AI draft. Existing source-generation and durable admission are
the only execution path. No scheduler, media cloning, inherited approval or
automatic publication enters this iteration.

The design must receive independent review before assigning implementation.
Review especially the bodyRevision/title digest distinction, fresh session
replay authority, createInTx callback extension, brand serialization against
source deletion, source-linked retry, and terminal snapshot erasure. Resolve
findings in the design before schema/code ownership is split. Do not record
proposed API routes or labels as already available in user guides.

## 1. Shared contract and database foundation

Assign one owner to shared schemas, lineage/operation tables and the next
available additive migration. Check the integrated head for migration numbering;
never assume the number from this older design checkout. Read migration rules
and obtain independent migration review before integration.

Define strict session reuse input, bounded source preview and internal-source
attribution projection, versioned source digest, refusal codes, operation cap,
consent literal and the existing idempotency-key parser contract. Reuse shared
normalization and existing `safe-stable-stringify`/Node SHA-256; no new serializer
or provider abstraction. Do not broaden ordinary RunCreate/public-write inputs.

Create tenant-owned operation audit and run-keyed lineage. Freeze source audit
values and consent actor/time, enforce scoped run/brand consistency, one-way
redaction and unique organization/operation/key identity. Store material once in
run input. Root source/result/request target IDs survive deletion as audit
UUIDs; freeze both request target discriminator and UUID separately from the
root source and resulting run. Consent actor IDs are bounded opaque Better Auth
text (1–255 characters), never UUIDs or deletion FKs;
lineage source deletion must not cascade into a derived draft. No backfill
fabricates internal lineage for legacy pasted material. Include indexed source
lookup and operation count, export inventory and tenant/brand cleanup policy.

Focused acceptance: DTO literal/parse boundaries (including 8,000 normalized
characters, NUL, title digest and forbidden cloned fields); schema/check/index
inventories; real migration upgrade, ownership/immutability/erasure constraints
and export policy. Tests use synthetic content. Update lock-order documentation
with the reviewed whole-product acquisition chain before repository work.

## 2. Atomic session admission and source preview

One backend owner owns the proposed Content reuse routes/repository and narrow
RunsRepository server-attribution callback integration. Controllers retain
ActiveOrgGuard, author capability and source brand scoping; repositories take
orgId first and use explicit projections. Session admission rechecks current
session, role and brand grant in both hosted and self-hosted modes. API keys
are denied; existing public writes retain their published contract.

Implement bounded read-only source preview with no opening/model side effects.
Implement both session target resolvers using an existing operation's recorded
request target discriminator/UUID, root source and brand for replay. Resolve
before generic source/original-run existence checks, so deletion/redaction does
not break a committed acknowledgement. Fresh reuse derives brand from the
current source; fresh reuse-retry derives it from the original run/lineage.
Hash path target UUID/discriminator and operation kind with the parsed DTO. Implement replay under admission
advisory/tenant/authority locks before fresh growth quota/current AI checks.
On a fresh operation acquire the stronger brand serialization lock only after
billing/admission and AI locks, then channels/source in the canonical order. Insert operation, lineage, run and
non-null queue job in one transaction through createInTx. Recheck selected
channels and source CAS under canonical locks; do not lock source first or
accept client-provided material. No provider call in this transaction.

Native acceptance: simultaneous same-key requests yield exactly one job/run;
changed key-body refuses; authorized replay after source edit/AI rotation/quota
exhaustion retains result; revoked scope/session refuses replay; missing result
returns 410 without a new job. Editing title alone and body/rich-body separately
invalidates reviewed source; invalid status, foreign brand/org and deleted
channel each refuse before durable work. Queue null/throw rolls back operation,
lineage and resource growth. Native concurrency proofs cover edit/delete/admit
lock order, not merely mocked method order.

## 3. Retry, deletion and provenance integration

Assign one owner to Runs retry, Content safe deletion and worker/output
attribution integration; serialize this owner with step 2 repository changes.
Generation remains the existing source pipeline, creates fresh AI versions and
ledger, and copies no delivery/review/media state. Internal source UUIDs never
become URLs or prompt/navigation instructions.

Fence every internal-source retry through the same paid operation contract and
brand serialization, preserving lineage. Refuse after redaction; ordinary
pasted-source retry remains unchanged. Handle archive/edit as frozen-source
continuation, not erasure or automatic generation cancellation.

Extend permanent deletion with union run locks in UUID order and recheck all
source lineage. Refuse live related runs; preserve existing delivery safety
checks. Terminal cleanup replaces input/checkpoints/guidance/template/error
snapshots with redaction and stamps lineage tombstones in the same deletion
transaction. Retain independent generated drafts, consent audit and usage,
without retained raw source title/body copies. Prove queue payload remains
ID-only and no idempotency full request/result snapshots or source-bearing logs
exist; include retry copies in the redaction set. Brand/tenant deletion and export
must cover the new tables. No shortened tombstone lifetime or audit-delete API.

Native acceptance: delete-versus-reuse and delete-versus-retry admit either a
fully committed fenced operation or a precise refusal, never a post-erasure
copy. Live derived run blocks source deletion until cancel/terminal state;
in-flight calls remain metered. Terminal run source/checkpoints are erased,
independent draft/versions remain, source link becomes unavailable and retry
refuses on fresh admission. Verify a committed identical reuse-retry replays
its existing result after original-run deletion/redaction, changed path UUID
under the same key refuses, and revoked session/brand access refuses replay.
No recovery case creates another job or exposes erased material; missing result
returns 410. Verify no exported raw source evidence after erasure and no
cross-org cleanup. Add a mutation proof for each critical race/erasure guard only after
native baseline stability; follow the project's three-run isolation rule and
label inconclusive host failures honestly.

## 4. Existing compose/content UI and guide

One UI owner owns content-detail entry point, compose internal-source mode,
source attribution projection, four message locales and user guide. Read UX
constitution and ui-ux-pro-max guidance. Reuse shared Modal/Advanced/components,
existing unsaved navigation protection and run page. No new sidebar screen.

Display source eligibility/refusal and saved master preview; resolve unsaved
original edits before reuse. Keep preview immutable, optional new title/brief
editable and active channels visible. Explicit modal names one new draft and
possible unknown provider charges. Generate is the sole admission action.
Preserve key/request while outcome is unknown; retain choices after 409 and
require explicit updated preview/new confirmation when the source changed.
Deliberate later reuse gets a new operation key. Do not silently retry a stale
request with fresh settings or a new key.

Source strips distinguish internal reuse from pasted/external material; show
frozen revision and permission-safe link or tombstone. Output receives fresh
human review/opening state. Explain source deletion removes retained evidence
while independent generated drafts/quotes remain; expose no personal content
or internal UUID troubleshooting as ordinary product instructions.

Focused UI acceptance: no request before paid confirmation, canceled consent
costs zero; literal request plus shared schema round-trip; timeout replay uses
same key; Russian coded source-change refusal preserves draft; title-only
change/reload requires new consent; reader hidden actions; inaccessible/erased
source no misleading link; new draft cannot borrow source approval/opening.
Run affected component and locale parity checks as one batch, not a full build
for every label fix.

## 5. Integrated acceptance, independent review and release

Root integrates the coherent stack once. Run shared/database/API/worker/web
quality gates and one production build tier sequentially on the shared host.
Broaden or repeat only affected checks after concrete failures; preserve
mandatory project gates and keep synthetic fixtures isolated. No automatic CI
loop or concurrent cold builds across agents.

Use a committed built-browser scenario against disposable PostgreSQL and the
scripted provider: create/edit a saved source, reuse preview, cancel once,
confirm one run, observe completion, open the independent draft, inspect
attribution and perform a human edit. Assert zero publication/scheduling jobs,
no copied media/review/delivery data and exact durable operation/job identities.
A second native scenario proves terminal source erasure and retained output.
Any model-call count assertion must follow actual role/adapter contracts,
not claim a universal fixed bill. No real provider calls are required.

Independently review the integrated diff, migration, release packaging,
idempotency/revocation and delete/retry concurrency evidence. Correct findings
in a coherent affected batch. Update README/spec index, roadmap and user guide
only when actual acceptance is demonstrated, and record known limitations
(8,000-character master-only intake, same brand, no automated recycling,
independent output retention). Commit/push the reviewed feature milestone under
root's release workflow. Main deployment requires the exact-head user approval
specified by the applicable repository instructions.

## Completion evidence

Delivery means source-grounded design review, native atomicity/erasure proofs,
fresh AI/human-review provenance, built-browser journey without publication,
verified workspace export/cleanup and an independently reviewed integrated head.
A written proposal or green unit mocks alone is not a delivered evergreen tool.
