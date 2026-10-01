# Public API

Pubrick exposes scoped APIs for tools you run. V1 reads content and publication outcomes; additive v2 permits draft intake and explicitly consented BYOK generation. The API cannot approve or publish, and a read never records the editor's “opened” signal.

The machine-readable contracts are [v1 OpenAPI](openapi-v1.json) and
[v2 OpenAPI](openapi-v2.json). Both use Bearer-only credentials and closed public
response projections.

## Create a key

An organization owner or admin opens **Settings → Public API → Manage API keys** and selects **Add**. Give the key a name that identifies its consumer. Pubrick displays the secret once; copy it into your tool's secret store before closing the dialog. At most 20 active keys are allowed per organization. Revoking a key stops subsequent requests immediately.

Choose exactly one scope: `content:read` for content list/detail, `publications:read` for publication outcomes, `content:create` for draft intake, or `generation:create` for consented generation and polling. Existing `content:read` keys keep their current access and do not gain publication access. Pubrick stores a SHA-256 hash of the full 256-bit-random bearer secret, not the secret itself. The visible prefix helps identify a key for revocation, but is not a credential. Never put a bearer key in a URL or commit it to a repository.

## Read content

All routes are under the instance's `/api` prefix. Send the key in the `Authorization` header. A signed-in browser cookie alone does not authorize these routes.

```http
GET /api/v1/content?limit=50&status=draft
Authorization: Bearer pbrk_…
```

The response is an array sorted by creation time and ID, newest first. Its fields are exactly `id`, `brandId`, `title`, `status`, `origin`, `createdAt`, and `updatedAt`. The default page size is 50; `limit` must be 1–200. If more results exist, the response includes `X-Next-Cursor`; pass its value as `cursor` on the next request. `status` accepts the same content statuses as the editor API.

```http
GET /api/v1/content/90ebcfc4-e20a-4b03-8501-0e883767a137
Authorization: Bearer pbrk_…
```

The detail response adds `body` to the list fields. It deliberately omits prompt versions, internal editorial notes, source credentials, generation inputs, client review links, and delivery internals. Both routes derive the organization from the verified key and return `404` for an item outside that organization. Responses use `Cache-Control: private, no-store`.

Invalid, missing, revoked, or wrong-scope keys receive the same `401 Invalid API key` response. A key does not authorize the editor's `/api/content` routes.

## Read publication operations

Use a `publications:read` key. A `content:read` key does not authorize this route, and a publication key does not authorize the content routes.

```http
GET /api/v1/brands/90ebcfc4-e20a-4b03-8501-0e883767a137/publications?filter=needs_attention&limit=30
Authorization: Bearer pbrk_…
```

The response is an array of current channel adaptations, newest first by creation time and ID. `filter` accepts `needs_attention` (default: manual-ready, failed, unknown or partial), `scheduled`, `published`, or `all`. The default page size is 30; `limit` must be a decimal integer from 1 to 100. If another page exists, pass `X-Next-Cursor` as `cursor` with the same filter. The cursor preserves microsecond timestamps, including rows created in one transaction. A missing brand and a brand in another organization both return `404`; an existing brand with no matching adaptations returns `[]`.

Each row contains exactly `id`, `contentItemId`, `channelId`, `platform`, `deliveryOutcome`, `failureReason`, `scheduledAt`, `publishedAt`, `externalUrl`, `assertedAt`, and `createdAt`. `failureReason` is a closed code, not provider prose. `unknown` and `partial` mean a send may already be live; check the channel before any human re-approval in the editor. `assertedAt` means a person resolved a delivery whose platform result was unknown. The public API omits the person's name, post text, raw errors, partial Telegram text, and credentials. Publication reads do not change delivery state. Responses use `Cache-Control: private, no-store`.

The current v1 surface has no write endpoints. The [MCP server](mcp.md)
exposes content tools through `PUBRICK_API_KEY` (`content:read`) and can expose `list_brand_publications` when a separate `PUBRICK_PUBLICATIONS_API_KEY` (`publications:read`) is configured. [Outgoing webhooks](webhooks.md) use
separate session-authenticated management routes and do not grant write access
to a public API key.

## V2 draft intake and consented generation

[V2 OpenAPI](openapi-v2.json) is additive. V1 retains its closed `ai|human` origin
representation and cursor format; externally supplied drafts are omitted from
v1 lists and return 404 on v1 detail reads. V2 `GET /api/v2/content` uses
`{rows, nextCursor}` with origins `ai|human|external`; v2 detail includes `body`.
Use only the returned cursor with the same filters and API version. Reading never
marks a draft as opened by an editor. Publication reads remain at their v1 routes.

Owner/admin issuance grants one exact **workspace-wide** scope, across all brands.
There is no hierarchy or implicit read access: `content:create` and
`generation:create` require separate keys from `content:read` and `publications:read`.

```sh
curl --fail-with-body https://pubrick.example/api/v2/content \
  -H 'Authorization: Bearer DRAFT_CREATE_KEY' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: draft.my-operation-001' \
  --data '{"brandId":"00000000-0000-4000-8000-000000000001","channelIds":["00000000-0000-4000-8000-000000000002"],"body":"Externally supplied draft"}'
```

The returned `{id,status:"draft",origin:"external",requiresReview:true}` is the
**original acceptance**, also on replay. Imported text has unknown authorship;
a human editor must open it before approval. Origin-changing edits do not remove
this requirement. Requests cannot set status, origin, approvals or publication.

`POST /api/v2/runs` requires the `generation:create` key, normal run inputs and
literal `allowPaidGeneration:true`, `consentVersion:"byok-paid-generation-v1"`.
At least one nonblank brief or material is required; optional image generation
and content-type rules remain those of the compose workflow. Providers/models
come from workspace settings, never request overrides. This consent permits
possible BYOK provider charges, including prices that are unknown. Estimates
are not spending caps. The original acknowledgement is `{id,status:"queued"}`;
poll `GET /api/v2/runs/{id}` with the same generation key for current status,
nullable `contentItemId`, closed safe error and cost provenance. Any null-priced or
unrecorded call makes cost `{status:"unknown"}`; otherwise
`{status:"known",amountUsd:"...",estimated:true|false}`. The required
`estimated` flag is true if any included cost comes from the maintained price
table. Such a total is an estimate, not a provider invoice or billing confirmation.
It is false only when all included priced calls have provider-reported costs.
Neither a reported amount nor an estimate is a spending cap. Unknown costs omit
both amount and estimate flag. Read the result with a separate content-read key.
Revoking a key blocks new requests/replays/polls, but does not cancel admitted jobs.

Every POST requires an ASCII `Idempotency-Key` (8–128 characters: letters, digits,
period, underscore, hyphen), plus JSON no larger than 1 MiB before parsing.
Persist the key and exact payload. Replays share the original operation across
keys in the same workspace and scope, after fresh authority checks. Different
parsed payloads return `idempotency_conflict`; deleted results return
`public_result_gone`, never regenerated. Replays precede quota/current AI selection
and operation capacity checks. Lifetime audit records are not evicted; operator
capacity is 100,000 operations by default (maximum configurable 1,000,000).

Writes including replays are limited to 30/minute/key and 60/workspace; polling
is 60/minute/key and 120/workspace. Rate refusal is 429 with bounded `Retry-After`;
limiter unavailability fails closed. A lost/invalid successful response leaves
acceptance **unknown**: retry the exact payload with the **same key**, never a new
one. The API provides no publishing, approval or editorial-opening capability.
