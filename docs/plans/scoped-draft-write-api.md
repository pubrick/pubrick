# Scoped draft write API execution plan

Status: all implementation slices integrated and locally verified; release pending.
Date: 2026-10-01.
Design: [0010](../specs/0010-scoped-draft-write-api.md).

The public-contract and admission/queue design reviews are complete. Corrections
include exact operation-bound authority, immutable imported-review obligations,
independent request limits, lifetime replay tombstones, truthful unknown cost,
and an explicitly versioned v2 representation. V1 retains its existing unsigned
cursor format and closed origin enum.

Foundation landed as `b9385c8a` on 2026-10-01. Focused shared, database, API,
web and worker checks passed, including real PostgreSQL authority/constraint
fixtures, imported-review and v1 HTTP tests, and every historical migration.
Migration 0125 received independent review. Backend, client and MCP slices now
pass assembled local acceptance, including the real browser import/edit/revoke
journey and committed queued generation with the scripted model. See the
[verification record](../reviews/2026-10-01-scoped-draft-writes.md).
These changes are on the feature branch and are not yet released on main.

## Sequence and ownership

### 1. Shared contract and admission foundation

One worker owns shared DTOs/scopes/origin definitions, database schema and the
single next migration, API authority plumbing, immutable imported-review gate,
legacy v1 filtering and the minimum UI provenance changes needed to keep the
expanded origin type usable. These files are not concurrently assigned elsewhere.
This ownership includes the narrow `CLAUDE.md` provenance clarification,
`deriveOrigin`, `OriginBadge`, version-history labels and authorship-claim tests:
imported intake records unknown authorship, not another AI sentence-mask state or
an originality/verification promise.
Foundation also documents the limiter table as shared operational infrastructure,
not tenant content. All tenant-owned operation/audit tables keep `org_id NOT NULL`.
Own workspace export policy/inventory updates: safe organization-scoped operation
audit/markers are exported; shared transient limiter counters are explicitly
omitted. Schema/check/timestamp inventories remain standalone green.

Define strict v2 draft/run inputs, closed projections, idempotency-header parsing,
versioned cursors and explicit consent. Add operation audit/tombstone storage,
immutable draft/run intake markers and the migration-owned limiter table/index.
The pinned `rate-limiter-flexible@11.2.1` adapter requires exactly three columns
in this order: `key varchar(255) PRIMARY KEY`, `points integer NOT NULL DEFAULT 0`,
`expire bigint NULL`. Its INSERT has no column list; adding tenant/audit columns
would break it. Add a nonunique `(expire, key)` expiry-cleanup index separately.
Runtime uses the fixed `public.api_request_limits` table, `storeType: "pool"`,
`tableCreated: true`, `clearExpiredByTimeout: false`. Freeze this adapter contract
before migration generation and prove it against the pinned dependency.
Add the direct pinned adapter dependency and native compatibility fixture in
foundation, rather than deferring the migration's first adapter test to backend.
Retain original audit UUIDs after resource/key deletion. Add explicit expected
operation and target checks to the verified authority/owning-transaction contract;
API keys are denied by generic SDK admission without the expected operation,
including self-hosted mode. Direct self-hosted calls without an API-key actor keep
their existing behavior.
Foundation owns the existing self-hosted boundaries in `tenant-quota.ts`,
`hosted-ai-call.ts`, DB resource/physical-call admission helpers and
`RunsRepository`: operation-bound API-key checks must execute before deployment
mode shortcuts. Do not turn on hosted billing for self-hosted installations.
Preserve actorless durable worker/system intents and session behavior. An API-key
actor with no matching explicit operation must refuse before a write or SDK call.

Preserve v1 projection and cursor contracts before the new origin can be written.
Require editorial opening for imported intake before the existing AI gate, after
all origin-changing edit/restore/refine paths. Extend neutral imported labels in
queue, detail and version history with locale parity. Complete focused schema,
authority, review and legacy-read checks. Independently review migration order,
constraints, deletion behavior and native fixtures before integration.

This slice lands first. The remaining writers start from its integrated HEAD;
they do not guess future DTO/helper exports or share a migration number.

### 2. Public backend operations

A backend worker owns public controllers/repositories/module glue, limiter service,
owned-transaction domain refactoring, consent/run audit plumbing and native public
write tests. It starts after slice 1 lands, then owns any further changes to the
content/run repositories. No parallel worker edits those files.
Run audit records remain associated with the generated result through the
existing run/result relation. `generation:create` uses actual AI versions and the
existing AI review-or-edit gate; only `content:create` has the immutable
imported-text opening requirement. Backend ownership includes worker generation
repository changes and focused tests if the run-audit pipeline needs them; do not
add an imported-origin marker to AI-generated output.

Reuse domain operations and transactional pg-boss insertion. Recheck capability
and targets before replay; replay precedes capacity/growth/AI selection. Persist
operation and result/job atomically, with explicit mismatch/gone behavior. Keep
run creation acknowledgement stable and expose current state through polling.
Return only narrow public projections and explicit unknown aggregate costs.

Use the foundation's pinned `rate-limiter-flexible` dependency and atomic PostgreSQL
counter adapter with migration-owned tables, no insurance/memory fallback and no
unbounded vendor cleanup. Give limiter SQL and pool checkout real server timeouts;
do not rely on a Promise timeout while leaving SQL running. Counter consumption
commits independently before domain locks. Use bounded observable housekeeping.
Use a dedicated owned PostgreSQL pool (direct API dependency or typed factory),
maximum two connections, 2-second checkout and server statement timeout, 1-second
server lock timeout and 10-second idle timeout. Own sanitized pool error handling,
nonoverlapping bounded cleanup and shutdown via `pool.end()`. Prove blocked-row
and exhausted-pool refusals natively; do not modify shared domain pool sessions.

Promote existing `safe-stable-stringify` to a direct API dependency for versioned
parsed-DTO hashes, configured deterministic/strict with cycles and BigInt rejected.
Project only JSON-safe effective DTO values; optional undefined fields have one
documented normalized meaning. Use Node's SHA-256 primitive, not a new JSON parser
or an interoperability claim. Pin compatible verified package versions and retain
notices. Explain chosen/rejected libraries in the implementation commit.

Prove native concurrent replay, differing payload, failed enqueue rollback,
revocation/deletion interleavings, key rotation/quota-full replay, lifetime capacity
and physical-call accounting. Prove cross-operation denial inside valid authority,
not only wrong route decorators. No live model or publication calls in tests.

### 3. MCP, settings and public setup

A separate client worker starts from slice 1 and owns MCP transport/server/CLI,
key-scope UI, remaining locale keys, v2 OpenAPI and public setup documentation.
It must not edit the backend's domain repositories or migration files.

Use the frozen shared contract and agree endpoint/acknowledgement shapes with the
backend worker before implementation. Keep default MCP API version v1; enable
write tools only with explicit v2 and their dedicated keys. In either mode,
publication reads retain the existing v1 publication endpoint. No global path
replacement, read-key fallback or automatically fresh replay keys.

Make write scope consequences, paid intent and revoke-after-enqueue semantics
visible beside the key controls. Reuse existing form/actions, neutral status and
accessibility patterns. Add strict transport/tool tests for timeout replay,
unknown outcome, cross-key/org isolation and imported v2 reads. Update public
examples with placeholders, v1 representation limits and v2 migration instructions.

### 4. One assembled verification and review

Root integrates the foundation, backend and client commits in order. Review
helper/DTO dependencies before running one relevant integrated gate: types/build,
Biome, affected API/DB/shared/MCP/web tests and the assembled native public write
journey. Use isolated databases; one heavy verification owner at a time. Repeat
only affected checks for concrete follow-up fixes.

Independently review the combined changes, especially all approval entry points,
rate-limit failure paths, SQL lock ordering, actual queue uniqueness and backwards
compatibility. An external-origin draft, replay and generated result must work
against a built disposable stack. Model transport stays mocked in this test;
the successful local saved-Google probe is separate evidence.

Push meaningful verified feature milestones. Inspect workflow triggers before
the final PR; do not dispatch GitHub Actions manually. Main merge/push and public
release publication remain governed by the project's explicit release rules.

## Remaining external acceptance

This slice does not resolve payment-provider/operator configuration, anonymous
multi-architecture public installation, commercial launch or the unavailable
in-app browser transport. Record those limits separately. Keep current local
operator data and its private recovery snapshot intact during development.
