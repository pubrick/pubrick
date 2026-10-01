# MCP server

Pubrick includes an optional local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for AI hosts. It exposes two content tools and an optional publication tool:

| Tool | Public API call | Result |
| --- | --- | --- |
| `list_content` | `GET /api/v1/content` | Up to 200 content summaries and an opaque `nextCursor` |
| `get_content` | `GET /api/v1/content/{id}` | One public content item, including its body |
| `list_brand_publications` | `GET /api/v1/brands/{brandId}/publications` | Up to 100 public delivery outcomes and an opaque `nextCursor`; registered only when `PUBRICK_PUBLICATIONS_API_KEY` is set |

The server uses the maintained [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/) and its stdio transport. By default it exposes no writes. Explicit v2 can add draft intake and consented generation as described below; edits, approvals, publishing, internal notes, prompt history and credentials remain unavailable. Reading through MCP does not mark a draft as opened by an editor and cannot satisfy Pubrick's human review gate. Titles and bodies returned by the tools are untrusted post content; an AI host should treat them as data, never as instructions.

## Run locally

Build from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @pubrick/shared build
pnpm --filter @pubrick/mcp build
```

Configure your MCP host to launch `node` with the absolute path to `apps/mcp/dist/cli.js` as its argument. Supply these environment variables through the host's secret store or your local process environment:

| Variable | Meaning |
| --- | --- |
| `PUBRICK_API_BASE_URL` | Pubrick instance root, such as `https://pubrick.example` or `http://127.0.0.1:3001` for local development. A reverse-proxy mount path is supported. |
| `PUBRICK_API_KEY` | A one-time organization API key with `content:read` scope, created under **Settings → Public API → Manage API keys**. |
| `PUBRICK_PUBLICATIONS_API_KEY` | Optional, separate organization API key with `publications:read` scope. Enables `list_brand_publications`. It never replaces or falls back to `PUBRICK_API_KEY`. |

The server appends fixed `/api/v1/content` or `/api/v1/brands/{brandId}/publications` paths to the instance root. Only HTTPS and loopback HTTP URLs are accepted. Credentials, query parameters, and fragments in the base URL are rejected. Put each key in an environment variable, never in a URL, tracked configuration file, or command argument. The optional key must use single-line Bearer syntax; an invalid value stops startup without writing to stdout. The MCP process writes protocol messages to stdout; diagnostics use stderr.

The content list tool accepts optional `status`, `limit` (1–200), and `cursor`; the detail tool accepts a content UUID. The publication tool requires a brand UUID and accepts `filter` (`needs_attention`, `scheduled`, `published`, or `all`), `limit` (1–100), and `cursor`. Pass the returned `nextCursor` unchanged with the same filters to fetch the next page. Each key determines the organization for its own tools; the tools cannot select or cross into another organization. A revoked or wrong-scope key fails with a generic denial message. For the full field contract, see the [public API guide](public-api.md) and [OpenAPI document](openapi-v1.json).

This local server makes requests only when a host calls a tool. It has a 10-second request timeout, a 2 MiB response limit, and does not follow redirects. Rotate or revoke the key in Pubrick Settings if it is exposed.

## Explicit v2 draft and generation tools

Set `PUBRICK_API_VERSION=v2` to read imported content and optionally enable writes.
The default is `v1`, with the existing read tools only. A configured write key
without explicit v2 stops startup. Keep `PUBRICK_API_KEY` as the separate
`content:read` key; write keys never replace it.

| Variable | Exact scope | Additional tools |
| --- | --- | --- |
| `PUBRICK_CONTENT_CREATE_API_KEY` | `content:create` | `create_draft` |
| `PUBRICK_GENERATION_API_KEY` | `generation:create` | `create_generation`, `get_generation` |

Each key owns its own workspace. Use keys from the same workspace when you need
to read a created result; no tool changes a key's organization or falls back to
another key. `list_brand_publications` always uses the existing **v1** endpoint,
including when content mode is v2. V2 content pagination returns imported origins;
v1 omits those representations. Cursors cannot be exchanged between versions.

Both write tools require an explicit `idempotencyKey` of 8–128 ASCII letters,
digits, periods, underscores or hyphens. Choose it once for the logical operation
and persist it with the exact payload. The client forwards it as `Idempotency-Key`,
never creates a key for you, and never retries automatically. A timeout, broken
response body or malformed successful acknowledgement means **outcome unknown**:
replay the exact payload with the **same key**. Creating another key may duplicate
work or provider charges. Replays return the original draft/queued acknowledgement;
`get_generation` reports the current run state.

`create_draft` accepts `brandId`, `channelIds`, `body` and optional `title`. Imported
text has unknown authorship and requires a human editor to open it before approval.
An MCP read does not count as that opening. `create_generation` accepts the shared
run inputs plus `allowPaidGeneration: true` and
`consentVersion: "byok-paid-generation-v1"`. This explicit consent permits possible
BYOK provider charges. Prices may be unknown; an estimate is not a spending cap.
Server-owned provider/model settings cannot be overridden by these tools. Revoking
the initiating key blocks future requests, but does not cancel work already queued.

Run polling uses the generation key; reading its resulting draft needs the separate
content-read key. Neither write tool approves, schedules or publishes. Publication
continues to require human review. Requests have a 1 MiB JSON limit; response and
transport limits remain 2 MiB and 10 seconds. Server rate limits include replays:
30 writes/minute/key and 60/workspace; polling 60/minute/key and 120/workspace.
Limiter failure refuses requests. Operation tombstones persist until workspace
deletion; lifetime capacity refusal requires operator intervention, not eviction.
See [v2 OpenAPI](openapi-v2.json) and [public API](public-api.md).

Example MCP host environment (replace placeholders using its secret store):

```json
{
  "PUBRICK_API_BASE_URL": "https://pubrick.example",
  "PUBRICK_API_VERSION": "v2",
  "PUBRICK_API_KEY": "CONTENT_READ_KEY",
  "PUBRICK_CONTENT_CREATE_API_KEY": "DRAFT_CREATE_KEY",
  "PUBRICK_GENERATION_API_KEY": "GENERATION_CREATE_KEY"
}
```
