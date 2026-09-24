# Public read API

Pubrick exposes a small, read-only API for tools you run. This first version reads content only. It cannot create, edit, approve, or publish a post, and a read never records the editor's “opened” signal.

The machine-readable contract is [OpenAPI 3.1](openapi-v1.json). It describes
the existing Bearer-only read routes and their public response fields.

## Create a key

An organization owner or admin opens **Settings → Public API → Manage API keys** and selects **Add**. Give the key a name that identifies its consumer. Pubrick displays the secret once; copy it into your tool's secret store before closing the dialog. At most 20 active keys are allowed per organization. Revoking a key stops subsequent requests immediately.

The key has the `content:read` scope. Pubrick stores a SHA-256 hash of the full 256-bit-random bearer secret, not the secret itself. The visible prefix helps identify a key for revocation, but is not a credential. Never put a bearer key in a URL or commit it to a repository.

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

The current v1 surface has no write endpoints. The [read-only MCP server](mcp.md)
uses these same scoped Bearer endpoints. Outgoing webhooks are documented
separately when enabled.
