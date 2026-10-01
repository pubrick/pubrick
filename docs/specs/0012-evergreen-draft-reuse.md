# Evergreen draft reuse

Status: PROPOSED; pending independent design review. No implementation or release claim.
Date: 2026-10-01.
Source baseline: `81b346fb` (main). Weekly editorial plans are a separate integration.
Execution: [plan](../plans/evergreen-draft-reuse.md).

## 1. User outcome and boundary

An author opens one saved content item, chooses **Reuse as source**, reviews its
saved master text, chooses active channels within that item's brand, and confirms
one paid generation. Pubrick creates one new reviewable draft through the existing
source-generation pipeline. The source remains unchanged.

This is the first bounded evergreen slice in [the roadmap](../roadmap.md).
It supplies the original product's source-repurposing workflow without inventing
an unattended recycling scheduler. Reuse pools, cooldown ranking, recurrence,
best-time claims, cross-brand reuse, media copying and public API/MCP reuse are
later decisions. Existing public write capabilities acquire no new authority.

No approval, human opening, review grant, client feedback, publication receipt,
platform ID, schedule, calendar attribution, cover, video, inline media or
adaptation override is copied. Generation does not publish or schedule anything.
The output must pass the ordinary opening, authorship and human delivery gates.

## 2. Existing contracts to reuse

These are shipped source facts at the baseline, not proposed endpoints:

| Source | Existing behavior / implication |
| --- | --- |
| `packages/shared/src/dto/runs.ts` | `runCreateSchema` accepts source material plus optional instructions; `MAX_SOURCE_TEXT_LENGTH` is 8,000 after newline normalization; channels are unique and bounded to 1–20. |
| `apps/api/src/runs/runs.repository.ts`, `createInTx` | One admission/provider snapshot/run insertion/durable enqueue path. Its `beforeInsert` callback currently returns an optional topic ID; it cannot attach internal lineage or override prepared material. |
| `apps/worker/src/generate/generate.service.ts` | Stored `kind: "source"` supplies material to existing generation roles; new calls receive new usage and AI evidence. |
| `packages/db/src/schema/content-items.ts` | Master body/title and `bodyRevision`; origin, opening and immutable imported-review obligation are distinct from editable content. |
| `packages/db/migrations/0094_ambiguous_jigsaw.sql` | `bodyRevision` increments for body/rich-body changes, **not title changes**. A revision alone cannot identify the whole displayed source. |
| `apps/api/src/public-api/public-write.repository.ts` | Atomic request hashing/replay before growth quotas and current AI selection; existing helper requires API-key authority and is not a session reuse handler. |
| `apps/api/src/public-api/public-request-hash.ts` | Maintained `safe-stable-stringify` plus Node SHA-256; reuse the library and canonical conventions, not a homemade JSON serializer. |
| `apps/api/src/content/content.repository.ts`, `delete` | Only safely archived unpublished drafts/rejections can be erased. Linked terminal runs have input/checkpoints redacted; active runs and delivery evidence refuse deletion. |
| `apps/web/src/app/[locale]/content/new/page.tsx` | Compose already owns source preview, channel selection, explicit generation and unsaved navigation protection. |
| `apps/web/src/app/[locale]/content/[id]/source-strip.tsx` | Current attribution describes an external paste/HTTP URL. Internal reuse needs a distinct source projection, not an internal ID hidden in `sourceUrl`. |

Manual `ContentRepository.createInTx` is unsuitable for cloning: ordinary manual
creation defaults to human origin. Copying model-written text through it would
invent human provenance. Use generation, not body cloning or draft-revision
acceptance (which edits the original item).

## 3. Source eligibility and reviewed snapshot

Eligible source statuses: `draft`, `approved`, `published`, `partially_published`.
These indicate saved material someone can intentionally repurpose; approval is
not transferred. Refuse `rejected`, `failed` and `archived`. The person can revise
or restore those through existing workflows first. Delivery activity on an
otherwise eligible source does not grant delivery authority to the output.

Source and all selected channels must belong to the current organization and the
same source brand. Use existing session editorial capability **author**, current
brand access and fresh admission authority, including self-hosted mode. Readers
cannot admit a run. Owner/admin access follows the current capability rules.
API-key actors are explicitly refused on the new internal route.

The source is the saved plain master `body`, not an adaptation, unsaved editor
text, rich-body JSON, prior version or media caption. Normalize newlines using
shared semantics; reject NUL, blank material and material above 8,000 characters
before admitting work. Never truncate. Show an inline refusal with the saved
length and bound; the existing manual source workflow remains available for a
separately curated excerpt, without falsely recording whole-item reuse lineage.

The source preview includes ID, brand ID, nullable title, body revision,
normalized body, status, saved origin and a server-computed snapshot digest.
Digest version 1 binds content ID, brand ID, exact nullable title, bodyRevision
and normalized material using deterministic serialization and SHA-256. Rich-body
changes invalidate the revision even if plain text is unchanged. Status is
rechecked for eligibility, not included in the digest: a delivery status change
alone should not invalidate unchanged editorial material.

The UI does not reuse while its original editor has unsaved changes. Offer Save
or discard through the existing navigation guard, then load a fresh saved
preview. Preview material is read-only in this slice. Instructions and new
output title remain editable. Source edits after preview cause a coded 409;
preserve instructions/channel choices and require an explicit preview reload
and renewed paid confirmation. Never silently admit the newer source.

## 4. Proposed HTTP contract and consent

The following routes are **proposed**, not currently shipped:

- `GET /api/content/:id/reuse-source`: scoped bounded preview from §3. No model,
  outbound fetch, opening stamp or generation admission. Check author capability.
- `POST /api/content/:id/reuse`: author session only; strict shared DTO below.
  Require one valid `Idempotency-Key` using the existing 8–128 ASCII contract.
  Return `{ id: runId, status: "queued" }`; replay returns the same operation
  acknowledgement and run ID. The existing run page supplies current status.

Request body:

```json
{
  "expectedSourceRevision": 7,
  "expectedSourceDigest": "<64 lowercase hex characters>",
  "title": "Optional new title",
  "brief": "Explain what should change for the new audience",
  "contentType": "social_post",
  "channelIds": ["<active same-brand channel UUID>"],
  "allowPaidGeneration": true,
  "consentVersion": "byok-paid-generation-v1"
}
```

`title` and `brief` use the existing generation bounds/normalization; blank
instructions may be omitted because source material is present. Content type
uses the existing shared enum and explicit UI selection. Initial defaults must
come from the compose defaults, not an invented inference from prior delivery.
Reject brand overrides, material, source URL, actor, origin, provider/model,
lineage, output status, media flags, feedback flags, SEO passes and schedules.
The server derives brand and full source material. Channels are 1–20 unique
active same-brand channels; do not silently remove missing selections.

A shared confirmation Modal displays source title/revision, output format and
selected channels. A required unchecked consent checkbox names **one run, one
new draft**, normal per-channel text adaptation, possible BYOK provider charges,
unknown prices and ordinary retries. No optional images or auxiliary editorial
passes are requested in this slice. Existing pipeline retry/role bounds apply;
we do not promise an exact physical-call count or a dollar spending cap.

Cancel before confirmation makes no request and costs nothing. Once admitted,
Cancel uses the existing run cancellation flow; completed/in-flight calls may
have spent money and remain metered. Retry after terminal failure is a separate
explicit paid action through §7, not an automatic new operation identity.

Proposed shared refusals: `reuse_source_changed` (409),
`reuse_source_ineligible` (409), `reuse_source_too_long` (400),
`reuse_source_redacted` (409), `reuse_operation_limit` (409), and
`content_delete_reuse_active` (409). Reuse existing missing-resource, authority,
channel, quota and idempotency refusals where semantics match. Localize coded
refusals in English, Spanish, Russian and Portuguese, never provider prose.

## 5. Atomic admission, replay and lock order

Introduce a session-owned reuse operation record; do not impersonate an API key
or broaden `PublicWriteRepository`'s allowlist. Organization, operation kind and
idempotency key form its unique identity. Keep normalized request hash/version,
root source ID/revision, brand ID, admitted result run UUID, immutable
`requestTargetKind` (`content` for reuse, `run` for reuse-retry) and
`requestTargetId` UUID, consenting actor ID, consent version and accepted
timestamp. The target ID names the original requested content/run, separately
from the root source and result run. Resource IDs are immutable audit UUIDs,
not nullable deletion FKs. Actor IDs use Better Auth's bounded opaque text
(1–255 characters), never UUID validation or a deletion FK. No body/title, full
request/result snapshot or source digest copy belongs in this operation table. Its opaque canonical request hash is replay audit, not
retrievable source text. The hash binds operation kind, target discriminator,
path target UUID and parsed DTO fields, so the same key cannot replay against a different content
item or original run. Tenant deletion cascades audit cleanup; the bounded
opaque actor ID survives account removal.

Use the admission advisory lock namespace already shared by runs/calendar. In
one transaction take advisory lock → organization lock → fresh session/user/
membership and brand authority → operation lookup. Fresh authority may take the
existing compatible brand `FOR KEY SHARE`; the stronger deletion-serialization
lock is acquired only after fresh admission/billing and AI locks, below.
Both reuse and reuse-retry routes resolve their target from an existing
org-scoped operation's immutable request target, root source and brand IDs for
a replay. A fresh reuse resolves from the current source; a fresh reuse-retry
resolves from the original run and its internal-source lineage. Compare the
operation kind, target discriminator and path UUID to the operation before
resolving brand authority. Do not require a still-existing source **or original
run** in the generic content/run resource guard before operation lookup: that
would make a committed operation unrecoverable after deletion. Do not accept
a caller-supplied brand to solve this. Replays require current author access to
the recorded brand, not merely knowledge of an operation key. The session
operation-based resolver precedes generic resource existence checks on the
internal reuse-retry branch of `/api/runs/:id/retry`; other retry kinds retain
the existing resource guard. No operation lookup leaks results to callers
without fresh session/brand authority.

For an identical authorized replay return the originally admitted **result
run** before checking current source eligibility, original-run existence or
redaction, quota or AI configuration. A committed reuse-retry can therefore
recover its result after its original run is deleted/redacted; this grants no
new work or access to erased text. Changing provider,
source or channels after admission cannot cause another run. A changed parsed
request under the same key refuses `idempotency_conflict`. If the original run
is gone, return 410 and keep the tombstone; never recreate it. Audit records have
no expiry/delete endpoint; cap fresh reuse operation records at 10,000 per
organization with a shared constant, while replays remain available at the cap.
A later retention/cap change needs its own design, not silent expiry.

On a fresh operation, prepare material from a server-side read, then invoke
`RunsRepository.createInTx` in the same transaction, preserving its admission,
selected-provider/credential snapshot and queue code. The existing callback is
insufficient: extend it narrowly to carry **server-owned source attribution**
without exposing those fields in ordinary RunCreate or public write DTOs. The
admission helper must not acquire tenant/authority/billing locks for the first time
after taking source/content locks. Reacquiring an already-held advisory/tenant/
brand lock in this transaction is harmless; introducing a reversed first lock
is forbidden.

After admission/billing and AI locks, take brand `FOR NO KEY UPDATE`, then
lock active selected channels in ascending ID
`FOR KEY SHARE`, then the source item `FOR SHARE`. The stronger brand lock serializes source deletion with reuse admission and
source-linked retry. No pre-existing run/adapter/channel lock needed by this
path may be acquired after its source content lock. New run insertion is
private to this transaction; its brand FK references the already-locked parent. Recheck tenant,
brand, eligibility, expected revision and digest under the source lock. Compare
locked normalized material/title to the prepared server snapshot as well. If
anything changed, rollback all admission, operation and queue writes. This
closes TOCTOU even though `createInTx` prepares `material` before its callback.
Do not insert placeholder material and later mutate an admitted prompt.

The run, lineage record, operation audit and real pg-boss job commit together.
Queue payload stays the existing `{ id: runId, orgId }`, never material/title,
source preview, source digest or a serialized reuse request. Admission logs
contain only sanitized operation/run identifiers; never copied text. Public
and internal operation acknowledgements contain only run identity/status.
Treat a null queue job as failed durable admission, not success. Pass shared
`kind: "source"` input with `sourceUrl: null`; the worker uses ordinary source
roles. Queue replay or process restart remains fenced by the existing run lease.
Update [lock order](../lock-order.md) during implementation and prove both
admission-versus-edit and admission-versus-delete against native PostgreSQL.

## 6. Immutable lineage and new output provenance

Add a tenant-owned lineage row addressed by derived run UUID, containing source
content UUID, same brand UUID, frozen source revision/title/digest/origin,
accepted timestamp and nullable `sourceRedactedAt`. Source UUID is an audit value
without a cascading FK; deleting the source must not delete an independent
output. Run FK may cascade when the whole run/brand/tenant is deleted. Enforce
org/brand/run consistency with composite constraints and explicit scoped joins.
Index `(org_id, brand_id, source_content_id, derived_run_id)` for deletion checks.
No second stored source body: run.input.material is the one retained raw copy.

Lineage is immutable except the one-way erasure transition in §7. Output
`pipeline_runs.content_item_id` is assigned by the normal fenced terminal write;
lineage follows the run and is not another mutable content relationship.
Every new master/adaptation version receives its own new AI evidence. Original
source origin is descriptive snapshot data, not authorship attribution for the
output; never copy source version IDs, human edits, approved sentence masks,
opening dates or AI accounting into new versions.

Extend narrow internal run/content projections and workspace export inventory
explicitly. Do not leak raw source material into queue polling or public v1/v2
projections. The draft/run source strip says **Reused from saved content**,
shows frozen title/revision and links only when the current viewer can read the
source. Missing/inaccessible source shows neutral unavailable attribution,
without exposing title to someone lacking current source access. Erased source
shows a localized tombstone and no title/material link. The worker receives
material as ordinary source context, not source UUIDs or internal navigation.

## 7. Source deletion, cancellation and retry

Archive is reversible and does not erase saved content: already admitted reuse
continues from its frozen material. New admissions from archived content refuse.
Editing or removing a channel later uses existing worker/channel fences; it
does not rewrite the frozen request or admit replacement work automatically.
Cancel a derived run through existing `RunsRepository.cancel`; retain ledger
rows and already checkpointed work. Cancelling a run does not delete its source.

Permanent source deletion preserves all existing safety restrictions. Extend
its current brand → runs (sorted UUIDs) → adaptations → content_items chain:
collect the union of runs directly producing the source and **all reuse/retry
runs whose lineage names that source** while holding brand `FOR NO KEY UPDATE`.
Lock the union in ascending UUID order before source adaptations/item locks.
Every writer creating or retrying such lineage must take that same brand lock,
so this set cannot grow during deletion; recheck the set before erasing.
Foreign org/brand links refuse deletion rather than being silently ignored.

If any union run is queued/running, refuse `content_delete_reuse_active` with
links the actor can read: cancel/wait for those runs, then explicitly retry
Delete. Do not auto-cancel paid work or archive/delete generated outputs.
Deletion holds no network locks and never assumes a cancel response means an
in-flight provider call did not spend money.

For safe terminal related runs, in the source deletion transaction redact
**all** their content-bearing input, steps, guidance/template snapshots and
errors using the existing redacted-run shape. Do not merely remove the
material key while checkpoint prompts still contain the copied source. Stamp
the related lineage tombstone and remove frozen title/digest/origin; retain
source UUID/revision, run UUID, acceptance time, actor/consent audit and usage.
The original source's own run redaction and existing safe-delete checks remain.
Do not retain the source body in operation/export/audit payloads or logs.
The ID-only queue payload and narrow operation acknowledgement require no text
erasure. Retained request hashes do not reconstruct request bodies; no separate
idempotency request/result snapshots exist. Verify these properties explicitly
rather than only clearing run.input. Retry lineage points at the same root
source UUID, so every frozen-material retry is in the union redaction set.

A completed derived draft is independent editorial output and remains readable,
editable and separately deletable under existing rules. Source deletion erases
the **retained raw source evidence**, not every downstream paraphrase or quote,
publication record, independent output version or provider-held request. State
this distinction in Delete confirmation/help; make no transitive erasure or
provider-erasure promise. A later reuse of that output has that output as its
immediate source. This slice does not implement graph-wide personal-data erasure.

Generic retry is a material-copying path and is in scope. A retry of an internal
reuse run must preserve server-owned lineage/source UUID and use the same brand
serialization, redaction check and explicit paid consent/idempotency contract.
Do not let `/runs/:id/retry` bypass the feature through ordinary RunCreate or
omit lineage. After source redaction, every related run is redacted and a
**fresh** retry refuses `run_redacted` before copying material. An already committed identical
reuse-retry operation replays its result under §5 before fresh redaction or
original-run existence checks; a deleted result still returns 410. Before
redaction, retry may reuse its frozen accepted snapshot even if the source was edited/archived;
preview labels that frozen revision, never the current source. For internal
reuse, the existing `POST /api/runs/:id/retry` requires a strict paid-confirmation
body (`allowPaidGeneration: true`, the existing consent literal) and the same
idempotency header. Its hash binds the original run UUID and operation kind
`reuse-retry`. Frozen original instructions/channels/material remain
server-owned and are shown in the confirmation. Other run kinds keep their
current retry contract; API-key actors acquire no retry capability. A reused
run or retry cannot be flattened into ordinary pasted-source RunCreate input
by the server, or hidden behind a generic Retry button without consent.
Fresh **Reuse as
source** remains a new source-CAS admission with a new explicit operation key.

Brand/tenant deletion cleans operations and lineage through owned cascades and
preserves ordinary ledger accounting semantics. Workspace export includes
scoped lineage/tombstones/consent audit and excludes erased source text. No
migration backfills fabricated lineage for historical pasted-source runs.

## 8. UI and acceptance

Keep one entry point in the existing content detail action area, beneath its
primary editorial action; no new sidebar page. The wording **Reuse as source**
is fixed across eligible statuses. Use the existing compose screen with an
internal-source mode, read-only saved preview and the same form/channel controls.
Generate remains beside the form; explicit paid consent uses the shared Modal.
Do not send a run on navigation, preview, selection or modal opening.

Show run progress in the existing run page and lead to the new draft. Fresh
opening/review is mandatory; the source's approvals or publication history do
not satisfy it. Preserve unsaved choices on 409/reload, display precise source,
channel, quota and unknown-cost feedback, and keep reader controls hidden.
Use shared components/tokens/focus trapping and four-language parity.

Acceptance must demonstrate one source → one operation/job/run → one new AI
draft with fresh review evidence; concurrent double clicks/timeouts replay the
same run. Native proofs cover source title/body edits, scoped authority,
channel deletion, same-key differing body, source deletion/retry races, live
run refusal, terminal redaction and retained independent output. Specifically
prove committed reuse-retry replay after original-run deletion and redaction,
changed-path UUID refusal under the same operation key, and revoked brand/session
authority refusing that replay. These cases may return the existing result ID,
never a second job or copied material. Built-browser
journeys use synthetic content and the scripted provider; exercise preview,
consent/cancel, run completion, source attribution and fresh human review without
publication. Real paid/provider calls are unnecessary for contract acceptance.

Independent review must settle the proposed callback/lock integration, session
operation table constraints and deletion disclosures before implementation.
This document records a proposed boundary, not implemented functionality.
