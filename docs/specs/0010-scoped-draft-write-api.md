# Scoped draft creation and generation API

Status: independently reviewed design; implementation pending.
Date: 2026-10-01.

## Product boundary

Extend the existing public API and maintained MCP SDK with optional, explicitly
issued write capabilities. Existing keys keep their current read-only scopes.
External callers can create a draft or request a paid BYOK generation run.
Only the authenticated editorial UI can record human review and approve delivery.
This slice does not expose approval, publication, scheduling, credential changes,
arbitrary outbound fetches, or platform-funded AI.

An installation with billing disabled remains usable. Hosted admission, tenant
deletion fences, physical-call leases and actual-call accounting apply through
the existing domain operations.

## Capabilities and HTTP contract

Keep one exact scope per key. Add `content:create` and `generation:create` to the
shared closed list and additive database constraints. Owner/admin issuance is
an explicit organization-wide capability; keys do not inherit browser brand
grants or a fictitious logged-in user. Existing keys cannot acquire a write
scope through an update or through request fields.

- `POST /api/v2/content`, scope `content:create`: strict draft DTO with brand,
  channel IDs, optional title and normalized bounded body. Return the new ID,
  draft status, external origin and review requirement, not the internal detail
  projection. Reject status, origin, approval, schedule and provider fields.
- `POST /api/v2/runs`, scope `generation:create`: strict projection of the
  existing run creation inputs plus `allowPaidGeneration: true` and
  `consentVersion: "byok-paid-generation-v1"`. Return the run ID and state.
  Consent names possible provider charges and unknown prices; no estimated
  number is a spending cap. Model/provider configuration stays server-owned.
- `GET /api/v2/runs/:id`, scope `generation:create`: narrow organization-scoped
  status projection with state, nullable result content ID, closed error code
  and known/unknown metered cost. A null-priced or unrecorded physical call makes
  the aggregate unknown; SQL sum must not turn it into zero. Never return briefs, intermediate steps,
  credential identities, internal errors or provider payloads. Reading the
  resulting draft uses the existing separately issued content-read capability.

Every write requires an ASCII `Idempotency-Key` header of 8–128 characters,
containing only letters, digits, hyphens, underscores and periods. New public
write routes have a 1 MiB JSON body limit before parsing. Use a maintained
PostgreSQL-backed limiter, without Redis: 30 write requests per minute per key
and 60 per organization, including replays; refuse on limiter storage failure.
New v2 run polling has limits of 60 requests per minute per key and 120 per
organization. Return 429 with bounded retry guidance. Public v1 does not already
have this limiter and its existing contract is not silently changed.
Provision the limiter table through a reviewed migration, not runtime DDL.
Commit request consumption independently before the domain transaction and hold
no limiter row lock while acquiring domain locks; a refused or failed write still
counts as a request. Cleanup expired limiter buckets only, never operation records.

MCP takes an explicit
idempotency-key argument; it must not invent a fresh key after a timeout.

## Authority and atomic idempotency

Replace the current API-key admission denylist with an explicit capability
allowlist. Verified immutable authority must carry a server-derived operation
kind. The owning transaction helper passes its expected operation and scoped
brand/channel targets into fresh admission; ordinary SDK admission with no
explicit public-write operation refuses API keys. A write operation binds its exact capability and target organization;
new scopes must never implicitly authorize unrelated SDK writes or paid calls.
Fresh authority checks also apply in self-hosted mode.

Use the established admission advisory lock, tenant lock and key-row lock order.
Recheck the key's organization, exact scope and revocation inside the owning
transaction before looking up a replay. Recheck target brand/channel ownership
inside that transaction. Revocation and organization deletion must serialize
with this admission; existing read routes retain their published behavior.

Persist an organization-scoped operation record, uniquely addressed by
organization, operation kind and idempotency key. Its normalized request hash,
original API-key ID, consent version, result ID and creation time are immutable.
Keep original result/key UUIDs as audit values, not foreign keys that silently
become null on deletion. Resource presence is checked separately. Tenant deletion
owns operation cleanup; there is no independently writable operation-delete API.
Hash the parsed DTO with a maintained deterministic serializer; do not store a
second copy of secret-bearing inputs. A valid replacement key with the same
scope may replay an organization operation, allowing recovery after key rotation.

Look up an existing operation after fresh authority but before growth quotas or
current AI selection. An identical replay returns the original result without
another resource reservation, job or model call, even after quota exhaustion or
model-setting changes. A different normalized request returns HTTP 409. A
deleted result returns an explicit gone result; never regenerate it or reuse
the operation key. Keep tombstones for the organization's lifetime, export
their safe audit fields and delete them with organization deletion. Under the
same tenant lock, cap new operation records at 100,000 per organization by
default, with a positive operator-configured maximum of 1,000,000. Existing
replays bypass this growth limit but not network/body admission. Return a closed
capacity refusal rather than dropping old tombstones or executing again; show
the operator-maintenance limit separately from commercial plan allowances.
Deleting a result never refunds operation capacity. At the absolute ceiling,
new intake stops; an operator must explicitly revise the capacity policy rather
than deleting old records and allowing old requests to execute again.

On a new operation, perform domain validation/admission and write the operation,
draft or run, and any pg-boss job in the same transaction. A failed enqueue rolls
everything back. Refactor an owned-transaction helper from existing repositories
instead of duplicating generation, credential selection or queue logic. Preserve
all browser-created draft/run behavior and lock-order contracts.

## Review and provenance

External text is not verified human writing and must not be labelled as AI
output without evidence. Add a closed `external` content origin, with additive
constraints for items, adaptations and versions. Imported draft/item versions
are labelled "Imported" using the existing neutral status treatment. Existing
human and actual AI provenance remain unchanged.

Persist an immutable external-intake operation marker independently of mutable
item origin. An externally created draft requires a real editorial `first_opened_at` signal
before approval. API reads, MCP reads, polling, exports, a client-supplied status
and an external initial version cannot satisfy this signal. Check this obligation
before the AI sentence gate, including after human edits, version restoration,
AI refinement/readaptation or other changes of origin. Preserve the
existing AI sentence/provenance gate when actual AI versions are later added.
Only editorial UI operations can record opening; no key route or MCP tool can
call the opened or approval endpoints. Imported origin is visible in queue,
detail and history in all supported locales.

The immutable imported-text review obligation applies to `content:create`, which
supplies text of unknown authorship. A `generation:create` run produces actual
AI versions through the existing worker and retains the existing AI read-or-edit
gate. Its initiating operation is run audit provenance, not an external content
origin or a second sentence-mask state. Preserve this distinction in the project
provenance constitution and its claim tests; neither path promises originality
or verification.

## Paid intent and revocation

Persist the initiating operation/API-key ID and consent version with each
externally requested run. The queued run is an already admitted domain intent,
not a restored browser session or request ALS context. Key revocation refuses
all later key requests and replays; it does not cancel an already admitted run.
Say this beside revocation and document the existing run-cancel action. Explicit
run cancellation, tenant deletion and lost dispatch fences still stop new calls
through the existing worker rules. Calls admitted before cancellation can finish
and their actual usage remains accounted for.

Use existing revision-pinned credentials, transactional job insertion, dispatch
admission, physical leases and every-attempt ledger writes. Do not introduce a
second provider pipeline, outer retry loop or zero-cost assumption.

## MCP and documentation

The existing v1 origin wire enum remains `ai|human`. Introduce v2 content list and
detail routes with the existing content-read scope and truthful `external` origin.
V1 lists explicitly exclude unsupported external-origin items before pagination;
v1 detail returns the existing not-found refusal for such an item. Document this
legacy representation limit. Do not silently map imported text to human or AI.
Keep v1's existing unsigned timestamp/UUID cursor format exactly unchanged.
V2 uses a separately versioned, audience-tagged codec that rejects legacy cursors;
v1 rejects the v2 envelope. Cursor coordinates are pagination input, not an
authorization token, and do not replace tenant scoping.

Register write tools only when their dedicated write key is configured and the
MCP API version is explicitly v2. Default MCP configuration stays v1. V2 read
tools accept imported-origin projections; examples pair each write key with a
read key for the same organization. Keep the
existing read tools and their configuration backward compatible. Each tool uses
its own key and the organization it addresses; no read-key or cross-organization
fallback. The run polling tool uses the same generation key as its create tool.
Publication-read tools keep the existing v1 publication endpoint in both modes;
v2 content mode does not invent a v2 publication route.
Write tool descriptions explicitly state possible BYOK charges, stable replay
keys and required editorial review.

Extend the existing bounded JSON transport, redirect refusal, timeout and closed
error handling to POST. A timeout is an unknown outcome: instruct replay of the
same operation. Update static OpenAPI, public API/MCP setup docs, Settings scope
options and locale parity together. Publish v2 setup and migration instructions;
the existing v1 OpenAPI projection stays closed. Add examples containing placeholders only.

## Acceptance

- Native concurrent identical POSTs produce one result and one generation job;
  changed payload conflicts, failed enqueue rolls back the operation, and a
  missing/deleted result never causes regeneration.
- Replay succeeds without new quota/queue usage after quota exhaustion and key
  rotation; revoked keys and cross-organization IDs cannot replay or mutate.
- Read keys cannot perform either write. Native tests prove cross-operation
  denial inside actual verified authority in self-hosted and hosted modes, not
  merely wrong-scope controller routing. Dedicated write keys cannot approve,
  publish, change settings or silently trigger unrelated paid SDK operations.
- An unread external draft cannot be approved through any route. Public/MCP
  reads never record opening; the existing editorial opening path enables the
  normal review workflow. Unopened import plus edits/restoration/later AI still
  refuses approval. Actual AI provenance tests remain green.
- Externally initiated runs retain consent/audit provenance, pinned selection,
  every-attempt usage and existing cancel/delete/fence behavior. Revocation after
  enqueue follows the documented already-admitted-intent policy.
- Public projections exclude private inputs and internal failures. MCP timeout
  replay uses the same key; tools are absent without opt-in write credentials.
- Verify per-key/org limiter isolation, limiter failure refusal and operation
  capacity with replay, plus body/header bounds before domain writes.
- Verify legacy v1 read shapes/pagination and v2 imported reads, versioned cursor
  refusal, explicit MCP version opt-in and unknown aggregate cost.
- Verify strict DTOs, migrations, locale parity, scope controls and OpenAPI/MCP
  examples. Run focused checks during implementation and one integrated relevant
  gate/review after assembly; do not repeat full gates after minor fixes.
