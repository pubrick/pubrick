# LLM providers

Workspace owners and admins can save one encrypted API key per provider in
Settings. Keys are not returned to the browser after saving. A provider's Test
button makes a small paid structured-output request and records its usage;
it does not merely check that the key looks plausible.

| Provider | Built-in text model | Connection |
| --- | --- | --- |
| Google | `gemini-3.8-flash` | Gemini Developer API; optional saved Google forward proxy |
| OpenRouter | `google/gemini-3.8-flash` | OpenRouter's model routing API |
| OpenAI | `gpt-6-luna` | Direct OpenAI Responses API |
| Anthropic | `claude-sonnet-5-5` | Direct Claude Messages API |
| DeepSeek | `deepseek-flash` | Direct DeepSeek Chat Completions API |

Defaults were checked against vendor model catalogs on 2026-09-30. You can set
another text model supported by that provider in Advanced. Model availability,
permissions and sufficient provider balance still depend on your API account.
An ordinary ChatGPT or Claude chat subscription is not an API key or API credit.
Vertex credentials and arbitrary OpenAI-compatible endpoints are not supported
by this increment. Vertex uses a distinct authentication mode; it must not be
treated as an ordinary Gemini Developer API key.

## What is supported

All five providers use the same draft generation, adaptation, revision and
structured-output validation pipeline. The AI SDK's maintained adapters implement
the vendor protocols; Pubrick does not maintain competing HTTP clients. Every
physical request, including a schema-repair request or a failed retry, uses the
existing usage recorder. Generation keeps its per-call run fence. Unknown costs
remain unknown rather than being displayed as zero.

OpenAI requests use non-strict JSON-schema guidance because the shared adapter
and editor schemas allow omitted fields. Strict OpenAI schemas require every
field to be present; Pubrick keeps its existing optional-field semantics and
validates each result locally, repairing invalid output once. This is not a
claim of native strict schema enforcement.

DeepSeek structured generation uses JSON-object output with schema instructions
and server validation/repair; it is not a claim of native strict JSON-schema
output for every DeepSeek model. A schema failure after repair produces the same
explicit failure as other providers.

Google-only features retain their separate Google-key requirement: Gemini image
generation, knowledge embeddings/search, website-to-brand import, and automatic
paid reply analysis. Choosing a different text provider does not turn these into
that vendor's image or embedding API. A saved Google key can coexist with another
text provider. The generic text pipeline selects the most recently added
provider credential (`created_at`); replacing an existing key does not reorder providers. An explicit
per-run/provider choice is not introduced here.

## Retention, proxy and costs

OpenAI Responses requests always set `store: false`, including tests and schema
repairs. Pubrick maintains its own draft/history records and does not opt into
provider response storage. This flag is not a promise of zero vendor retention:
provider policies and account settings still apply.

Direct provider endpoints are fixed to the official vendor hosts. OpenAI's
ambient `OPENAI_BASE_URL` cannot silently redirect a workspace key. The saved
Google proxy is used only for Google requests; it does not proxy OpenAI,
Anthropic, DeepSeek or OpenRouter.

Direct-provider token usage is recorded, but this increment intentionally leaves
unconfirmed local cost estimates unknown. Account tier, caching and provider
pricing rules must be modeled before claiming invoice accuracy. OpenRouter's
reported cost and the existing verified Google price table retain their existing
rules. Prices and subscription fees are separate concerns.

## References

- [AI SDK OpenAI adapter](https://ai-sdk.dev/providers/ai-sdk-providers/openai)
- [AI SDK Anthropic adapter](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic)
- [AI SDK DeepSeek adapter](https://ai-sdk.dev/providers/ai-sdk-providers/deepseek)
- [OpenAI structured-output schema requirements](https://developers.openai.com/api/docs/guides/structured-outputs)
- [OpenAI GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Claude model catalog](https://platform.claude.com/docs/en/models/overview)
- [DeepSeek model identifiers](https://api-docs.deepseek.com/)

## Upgrade notes

Stop the previous worker before starting the new API, which widens the provider
checks at startup; start the matching new worker only once API health passes.
An older worker cannot resolve a newly saved direct-provider key. The default
Google/OpenRouter rows remain unchanged.

Migration `0117_direct_llm_providers` replaces the credentials and usage-ledger
provider checks with widened `NOT VALID` constraints. New writes are checked
immediately; startup does not scan a large historical usage ledger while holding
an exclusive table lock. After upgrade, an operator can validate them in a
separately scheduled maintenance step:

```sql
ALTER TABLE ai_credentials VALIDATE CONSTRAINT ai_credentials_provider_check;
ALTER TABLE usage_ledger VALIDATE CONSTRAINT usage_ledger_provider_check;
```

Validation scans existing rows and takes a table lock compatible with ordinary
reads/writes; coordinate it with other schema maintenance. The previously
validated narrower checks already establish the validity of old provider values.
Do not downgrade to a binary that only accepts Google/OpenRouter after storing
direct credentials or usage without a separately planned data recovery.
