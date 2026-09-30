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
text provider. Settings has one **Text generation** selection for the workspace provider and
model. Saving or replacing a key does not change this selection. Existing
workspaces preserve their first-added credential and its model on upgrade
(`created_at` ascending, with provider-name tie breaking). Deleting the selected
key keeps the selection visibly unavailable; Pubrick never silently bills another
provider. Choose another saved provider explicitly to resume new generation.

New pipeline runs retain the selected provider, model, credential ID and credential
revision. Existing runs keep their original model after a workspace default edit.
Replacing a key or changing its Google proxy increments the credential revision;
the next physical request refuses with `configuration_changed`. Requests already
admitted before the change commits may finish. The check runs again for native
SDK retries and schema repairs, and refusals before HTTP do not create paid usage.

Resumed legacy runs infer their text provider/model only from identifiable text
usage. Image and embedding ledger rows do not establish text provenance. Missing
accounting, mixed historical configurations, or checkpoints without text usage
require an explicit retry rather than inventing a provider history. Topic
suggestions, claim reviews and relevance requests retain their first admitted text
configuration across queue redelivery. Editor refinements select once per request.

The existing **Test** button remains on each provider credential row. Its displayed
model is the workspace model for the selected provider, otherwise the credential's
legacy/default model. A model change invalidates the displayed verdict. Saving
text settings uses a revision check: stale concurrent writes ask the user to reload.


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


Migration `0118_text_defaults_and_pins` retains the oldest configured provider and
model, adds credential revisions and nullable snapshots to existing work, and
widens auxiliary refusal/Autopilot decision checks with `NOT VALID`. New rows are
checked immediately. Existing encrypted credentials and usage records are not
rewritten. Stop old workers before the matching API upgrade and restart matching
workers only after API health; old workers do not enforce the new selections.

Operators can validate the widened checks separately after the upgrade:

```sql
ALTER TABLE ai_credentials VALIDATE CONSTRAINT ai_credentials_revision_check;
ALTER TABLE autopilot_manual_attempts VALIDATE CONSTRAINT autopilot_manual_attempts_decision_check;
ALTER TABLE autopilot_scan_events VALIDATE CONSTRAINT autopilot_scan_events_decision_check;
ALTER TABLE claim_reviews VALIDATE CONSTRAINT claim_reviews_error_code_check;
ALTER TABLE news_relevance_batch_items VALIDATE CONSTRAINT news_relevance_batch_items_error_code_check;
ALTER TABLE news_relevance_batches VALIDATE CONSTRAINT news_relevance_batches_error_code_check;
ALTER TABLE news_items VALIDATE CONSTRAINT news_items_relevance_error_code_check;
ALTER TABLE topic_suggestion_requests VALIDATE CONSTRAINT topic_suggestion_requests_error_code_check;
```

Legacy suggestions with earlier attempts, relevance batches already running,
and relevance items with earlier scoring attempts refuse ambiguous configuration.
Untouched queued legacy batches pin before their first running transition. Start
new suggestions/recheck requests, or use an item's explicit scoring retry, after
reviewing Settings. Newly pinned work preserves its configuration on redelivery.
