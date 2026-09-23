# Brand knowledge

Each brand has its own collection of notes at **Brands → Brand knowledge**. A
note has a title, content, category, tags, and an active switch. The API scopes
every read and write by both the active organization and the brand. Removing a
brand also removes its notes.

## Using notes

The generation worker selects up to five active notes for a run. If the brand
has indexed notes and the organization has a Google API key, it embeds the
brief (or pasted material) and orders indexed notes by pgvector cosine
distance. It fills remaining slots from PostgreSQL text search, including
unindexed notes. Without an available Google key or vector, it uses text
search alone. A text search matches words rather than meaning, so a note with no
matching terms may not appear. Paused notes are never selected.

Selected notes enter the researcher and writer as fenced **material**, never
system instructions. This adds context; Pubrick does not check whether a note
is accurate, or whether the resulting post is original. The usual human review
and approval gate still applies.

The generation receipt lists the notes selected for that run and links to each
note in the brand library. It retains the selection in the run checkpoint, so
later edits to a note do not rewrite the receipt. Older checkpoints without
note IDs show titles without links. A selected note is context supplied to the
model, not evidence that a particular claim was verified or that the model
used every part of it.

Use **Index** on a saved note to create its vector. This needs the
organization's Google key from Settings and uses `gemini-embedding-001` at 768
dimensions. An edited title or body clears the old vector immediately, so the
model cannot retrieve new prose by a stale vector. Index again after editing.
The endpoint refuses a concurrent text edit by checking the note's text after
the provider call. A provider failure leaves the note available to text search.

## Importing an existing knowledge base

Select **Import CSV** on the brand knowledge page. The file must be UTF-8 CSV
with `title`, `content`, and `category` headers; `tags` is optional. Quoted
commas, quotes, and newlines are supported. Separate multiple tags with `|`
or `,` inside the tags cell. The browser previews the validated batch before
import. It accepts up to 500 rows and a file up to 1 MB. An invalid row stops
the whole import, and the API inserts the accepted batch in one transaction.

Imported notes are searchable by text immediately. They do not get embeddings
automatically. An organization owner or admin can click **Index next 10** to
index up to ten active, unindexed notes in one explicit Google request. Repeat
the click to continue. The page shows how many notes remain and the outcome of
the most recent batch. Paused notes are skipped. Each click uses the
organization's Google key and is serialized per brand across API instances;
an edit or pause during the request prevents the old vector from being saved.
The server uses the AI SDK's `embedMany` with `gemini-embedding-001` at 768
dimensions. It checks returned vector count and dimensions before saving.
Malformed vectors remain unindexed and can be retried. A provider failure
leaves notes searchable by text. No indexing request is made by CSV import.
If Google does not confirm a result, the ledger records an unknown outcome;
the page warns that the call might still have been billed before a retry.
The schema fixes all stored vectors at 768 dimensions, and every current
document and query embedding path pins `gemini-embedding-001`. Notes do not yet
store embedding model provenance. Supporting a second embedding model requires
model/dimension metadata, retrieval filters, and a deliberate reindex plan;
changing the model constant alone would mix incomparable vectors.
The importer accepts a CSV selected by the user; it does not connect to the
previous Ozon Tools database or migrate its stored notes automatically.

Embedding calls have no price in Pubrick's current model price table. Each
batch provider attempt creates one `knowledge_batch_index` row in
`usage_ledger`, with unknown cost. The pinned Google adapter does not return
token usage; the ledger stores zero as an unavailable placeholder rather than
an estimate, and the batch response marks `tokensKnown: false`. Thus spend
totals are a lower bound. If a provider call succeeds but the ledger cannot be
written, the response sets `usageRecorded: false` and still saves valid
vectors; inspect the ledger before retrying. The SDK makes no internal retry
for an embedding call. Generating a query vector is checkpointed as a `knowledge`
step, so a resumed run does not pay for it again after a successful checkpoint.

Retrieval currently covers the brand's knowledge notes. It does not search
historical posts, published content, or monitored news. The API returns the
whole note list for a brand; server-side filtering and pagination are not yet
available.

## API

- `GET /api/knowledge?brandId=<uuid>` lists the brand's notes without vectors.
- `POST /api/knowledge` creates a note with `brandId`, `title`, `content`,
  `category`, and optional `tags`.
- `POST /api/knowledge/bulk-import` accepts `{brandId, entries}` with 1–500
  validated entries and returns `{created, ids}`.
- `GET /api/knowledge/index-summary?brandId=<uuid>` returns the count of active,
  unindexed notes.
- `POST /api/knowledge/index-batch` accepts `{brandId}` from an organization
  owner or admin. It returns counts for selected, indexed, changed, invalid,
  and remaining notes; the optional reason; `usageRecorded`, `tokensKnown`,
  model ID, and dimensions. It sends at most ten notes per call.
- `GET`, `PATCH`, `DELETE /api/knowledge/:id?brandId=<uuid>` address one note.
- `POST /api/knowledge/:id/index?brandId=<uuid>` builds a vector and reports
  `{indexed: true, entry}` or `{indexed: false, reason}`.

The categories are `product_info`, `brand_guidelines`, `case_study`,
`tone_example`, `competitor`, and `customer`. Requests require an active
organization. A missing or cross-brand note returns the same 404.

## Implementation choice

The existing open-source Vercel AI SDK (`ai` and `@ai-sdk/google`) supplies the
Gemini embedding call. Drizzle ORM supplies the pgvector column and
`cosineDistance`; the PostgreSQL extension was already enabled. This keeps
provider and vector behavior in maintained libraries while the application
owns tenant scoping, note lifecycle, prompt boundaries, and cost records.
LangChain JS would add another orchestration layer and dependencies for this
small retrieval path without replacing those product-specific rules.
The CSV reader uses the maintained MIT-licensed `csv-parse` package, leaving
CSV quoting and escaping to a library while Pubrick applies its own input
schema and tenant checks.
