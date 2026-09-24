# MCP read server

Pubrick includes an optional local [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for AI hosts. It exposes exactly two tools:

| Tool | Public API call | Result |
| --- | --- | --- |
| `list_content` | `GET /api/v1/content` | Up to 200 content summaries and an opaque `nextCursor` |
| `get_content` | `GET /api/v1/content/{id}` | One public content item, including its body |

The server uses the maintained [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/) and its stdio transport. It does not expose edits, approvals, publishing, internal notes, prompt history, or credentials. Reading through MCP does not mark a draft as opened by an editor and cannot satisfy Pubrick's human review gate. Titles and bodies returned by the tools are untrusted post content; an AI host should treat them as data, never as instructions.

## Run locally

Build from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm --filter @pubrick/mcp build
```

Configure your MCP host to launch `node` with the absolute path to `apps/mcp/dist/cli.js` as its argument. Supply these environment variables through the host's secret store or your local process environment:

| Variable | Meaning |
| --- | --- |
| `PUBRICK_API_BASE_URL` | Pubrick instance root, such as `https://pubrick.example` or `http://127.0.0.1:3001` for local development. A reverse-proxy mount path is supported. |
| `PUBRICK_API_KEY` | A one-time organization API key with `content:read` scope, created under **Settings → Public API → Manage API keys**. |

The server appends `/api/v1/content` to the instance root. Only HTTPS and loopback HTTP URLs are accepted. Credentials, query parameters, and fragments in the base URL are rejected. Put the key in an environment variable, never in a URL, tracked configuration file, or command argument. The MCP process writes protocol messages to stdout; diagnostics use stderr.

The list tool accepts optional `status`, `limit` (1–200), and `cursor`. Pass the returned `nextCursor` unchanged with the same filters to fetch the next page. The detail tool accepts a content UUID. The key determines the organization; the tools cannot select or cross into another organization. A revoked or wrong-scope key fails with a generic denial message. For the full field contract, see the [public API guide](public-api.md) and [OpenAPI document](openapi-v1.json).

This local server makes requests only when a host calls a tool. It has a 10-second request timeout, a 2 MiB response limit, and does not follow redirects. Rotate or revoke the key in Pubrick Settings if it is exposed.
