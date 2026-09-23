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
automatically; use **Index** on notes where semantic matching matters. This
keeps a large legacy import from making unreviewed provider calls.
The importer accepts a CSV selected by the user; it does not connect to the
previous Ozon Tools database or migrate its stored notes automatically.

Embedding calls have no price in Pubrick's current model price table. Their
token use is recorded in `usage_ledger` with an unknown cost, so spend totals
are displayed as a lower bound. The SDK makes no internal retry for an
embedding call. Generating a query vector is checkpointed as a `knowledge`
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
