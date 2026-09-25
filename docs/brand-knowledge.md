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

The claims step may attach a short excerpt from a selected note or the pasted
text to an individual claim. The worker accepts that pair only when the source
ID belongs to this run and the normalized excerpt occurs exactly in the saved
snapshot. Invented excerpts and IDs are discarded; the claim stays on the
**Claims to verify** list. The receipt labels an accepted excerpt "Found in
brand note" or "Found in supplied material" and shows the actual words.
The link beside a brand excerpt opens the *current* library note, which may
have changed since the run; the excerpt itself remains from the run snapshot.
These excerpts show where supplied material said something, not that Pubrick
checked whether it was true. A recorded source URL is never fetched as part of
this step and cannot support an excerpt by itself.

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

Use **Export CSV** to download the current brand notes, including paused notes
and literal tags. Pubrick reads the latest brand list before export. A small
export is one CSV file; larger exports arrive as one ZIP containing CSV parts
that each fit the 500-row and 1 MB import limits. Unzip it and import each part
into the desired brand. The export excludes embeddings, credentials, internal
IDs, and timestamps. A reimport creates new notes, so do not import the same
part twice. Treat CSV as data when opening it in spreadsheet software: import
text cells as text, since arbitrary note content can start with spreadsheet
formula characters.

Select **Import CSV** on the brand knowledge page. The file must be UTF-8 CSV
with `title`, `content`, and `category` headers. Optional `is_active` preserves
the note's paused state: its cells must be exactly `true` or `false` in
lowercase. When the header is absent, notes are active by default for
compatibility with older CSV files. An empty or malformed `is_active` cell is
rejected rather than silently activating the note. Optional `tags_json` is a
JSON array of strings, such as `["coffee, roasted","bulk|B2B"]`. Use it when a
tag itself contains a comma or pipe. If both `tags_json` and the older `tags`
column are present, `tags_json` takes precedence; every cell in that column
must contain a valid JSON array (use `[]` for no tags). Files with only `tags`
still work, splitting its cell on `|` or `,`. Quoted CSV commas, quotes, and
newlines are supported. The browser previews the validated batch, marking
paused notes. It accepts up to 500 rows and a file up to 1 MB. An invalid row
stops the whole import, and the API inserts the entire batch in one transaction.
The API also accepts an optional boolean `isActive` on each bulk-import entry.
Titles, content, categories, and tags must pass the same limits as an individual
note (500 title characters, 20,000 content characters, 20 tags of 50 characters
each).

For a portable export from another system, first extract its notes to a local
UTF-8 CSV without embeddings, provider keys, or internal IDs. Map each note's
title, content, and category to Pubrick's columns; serialize its tag array as
JSON into `tags_json`, and its enabled state as lowercase `true` or `false` in
`is_active`. A CSV writer should quote fields containing delimiters or
newlines. Split exports into files of at most 500 rows and 1 MB each, then
import each file into the correct brand. The importer does not connect to the
previous Ozon Tools database or copy its vectors. Reindex active notes in
Pubrick after import if semantic search is needed.

Imported notes are searchable by text immediately. They do not get embeddings
automatically by default. An organization owner or admin can click **Index next 10** to
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

An owner or admin can opt a brand into **Automatic vector indexing** on its
knowledge page. The worker scans hourly, handles at most ten eligible brands
per scan, and makes at most one ten-note Gemini batch per brand each day. It
records the 24-hour interval before provider I/O, including when an outcome
is unknown, so a worker restart does not immediately repeat a possibly paid
call. Automatic and manual requests share the same per-brand advisory lock.
Turning the setting off stops future batches. The worker uses only the
organization's stored Google key; notes remain available through text search
when a key is missing or a provider attempt fails. Brands without a Google
key are skipped without consuming their daily attempt; after the key is saved,
they become eligible on the next hourly scan.
The schema fixes all stored vectors at 768 dimensions. Each indexed note stores
its embedding model and dimensions; the migration labels existing vectors with
the only model previously used, `gemini-embedding-001`. Vector retrieval accepts
only that model and dimension pair. Supporting a second embedding model still
requires a deliberate reindex plan and a compatible vector schema; changing the
model constant alone would not make old vectors comparable.

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

Retrieval covers brand knowledge notes and up to two related public watched
stories. The story query requires the same organization and brand, an effective
relevance rank of at least 0.5 (AI score plus editor feedback), no explicit
irrelevant editor signal, and a date
within the last 30 days. Private Telegram sources are excluded. Compatible
768-dimensional news vectors share the one metered query embedding already
used by knowledge retrieval; text search works when indexing or the Google key
is unavailable. The selected title and summary are frozen in the run checkpoint
and limited to 2 KiB of UTF-8 across both stories, so a retry uses the same
context without another retrieval call. Story URLs appear only as safe HTTP
links in the run receipt, never in model material. Feed excerpts are context,
not independent verification; claims remain for a human to check. Historical
posts and published content are not searched. The API still returns the whole
note list for a brand; server-side filtering and pagination are not yet
available.

## API

- `GET /api/knowledge?brandId=<uuid>` lists the brand's notes without vectors.
- `POST /api/knowledge` creates a note with `brandId`, `title`, `content`,
  `category`, and optional `tags`.
- `POST /api/knowledge/bulk-import` accepts `{brandId, entries}` with 1–500
  validated entries and returns `{created, ids}`.
- `GET /api/knowledge/index-summary?brandId=<uuid>` returns the count of active,
  unindexed notes.
- `GET /api/knowledge/auto-index?brandId=<uuid>` returns `{enabled, lastAttemptAt}`;
  absent configuration reads as disabled.
- `PATCH /api/knowledge/auto-index` accepts `{brandId, enabled}` from an
  organization owner or admin. It changes only that brand's opt-in setting.
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
