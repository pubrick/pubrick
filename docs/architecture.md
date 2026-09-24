# Architecture

A map for people and agents who arrive mid-flight. It says what lives where,
which rules cross package boundaries, and where each rule is enforced — so a
change can be checked against the whole rather than against the file it touches.

## The package graph

```
                    ┌──────────────┐
                    │ @pubrick/    │
                    │   shared     │   the rule book (zod, provenance, crypto,
                    └──────┬───────┘   money, queue contract, error codes)
             ┌─────────────┼─────────────┐
             ▼             ▼             ▼
      ┌───────────┐ ┌───────────┐ ┌──────────────┐
      │ @pubrick/ │ │ @pubrick/ │ │  @pubrick/   │
      │    db     │ │    ai     │ │ integrations │
      └─────┬─────┘ └─────┬─────┘ └──────┬───────┘
            └──────┬──────┴──────┬───────┘
                   ▼             ▼
            ┌──────────┐  ┌──────────┐        ┌──────────┐
            │ apps/api │  │  worker  │        │ apps/web │──▶ shared only
            └──────────┘  └──────────┘        └──────────┘
```

`shared` is a leaf and must stay one. `db`, `ai` and `integrations` depend on it
and on nothing else of ours. The two Nest apps depend on all four; the web app
depends on `shared` alone and resolves it from its **build** — a change in
`packages/shared/src` is invisible to `apps/web`'s tests until `dist` is rebuilt.

### What each package owns

**`packages/shared`** — everything that has to be true in more than one process:
the DTOs (`dto/*`) with their zod schemas and the closed status and error-code
lists every consumer derives its types from; the provenance rules
(`provenance.ts`, `refine-merge.ts`) that decide whether text is still the
model's; credential encryption and the key ring (`crypto.ts`); the ledger's cost
buckets (`cost-display.ts`); the queue contract (`jobs.ts`) both apps create
queues from; the credential ordering both apps must agree on. It has no runtime
dependency beyond zod, and the web imports it in the browser, so anything
Node-only in it is tree-shaken rather than forbidden — keep that in mind before
adding a Node import.

**`packages/db`** — the Drizzle schema (`schema/`) and the SQL migrations,
applied programmatically under an advisory lock at api boot. The schema
*imports* its enums from `shared` rather than restating them; a CHECK constraint
on every enum-bounded column is asserted in both directions by
`schema-invariants.test.ts`. Eighteen tables in six files: `auth.ts` (better-auth:
user, session, account, verification, organization, member, invitation),
`content.ts` (brands, channels), `knowledge.ts` (brand notes), `content-items.ts` (content_items,
adaptations, publications), `generation.ts` (ai_credentials, pipeline_runs,
usage_ledger, content_versions), `refine.ts` (refine_proposals),
`draft-revision.ts` (one staged whole-body suggestion per post).

**`packages/ai`** — every model call in the product. `defineStep` is the only
way to make a structured text step and is what keeps the untrusted-text boundary, the schema sent
to the model, and the ledger attribution from drifting apart. Five pipeline
steps live in `steps/`; knowledge embeddings use the AI SDK's `embed` with a
fixed model and dimension. The metering (`usage.ts`), the call budget
(`budget.ts`), the failure classifier (`classify.ts`) and the price table
(`pricing.ts`) are shared by every caller.

**`packages/integrations`** — publishers, one per platform, behind a registry
typed over the platforms `shared` declares as publishable. Today: Telegram,
VK community walls, MAX chats or channels, Bluesky accounts, and Mastodon
instances. A
publisher's errors are one of three kinds — permanent, transient, or unknown
outcome — and that distinction is the whole delivery story (below).

**`apps/api`** — NestJS, one module per domain (`brands`, `channels`, `content`,
`runs`, `knowledge`, `ai-credentials`, `org`, `queue`, `health`). Controllers never touch the
database; repositories take `orgId` first and select explicit column lists.
Runs migrations on boot. Enqueues jobs in the same transaction as the write
that justifies them.

**`apps/worker`** — NestJS standalone context, no HTTP. Two pg-boss queues
(`generate`, `publish`), each with a dead-letter queue and a five-minute sweep
for rows a dead handler left non-terminal. Every model call runs under the
run's fence; every send is claimed before the platform is called.

**`apps/web`** — Next.js, UI only, talking to the api through a `/api/*` proxy so
cookies stay first-party. Four locales with key parity enforced by test. One
design direction (`globals.css` + `components/ui`), with a contrast ratchet that
derives the painted colour pairs from the class lists.

## The runtime, end to end

```
browser ──/api/*──▶ api ──enqueue in tx──▶ pg-boss ──▶ worker ──▶ provider / platform
                     │                                     │
                     └──────────── postgres ◀──────────────┘
```

A draft is written (by hand, or by a five-step generation run) → adapted per
channel → opened and judged by the publish gate → approved, now or on a schedule
→ claimed and sent by the worker → recorded as a publication with its id and
link, or as a failure, or as an outcome nobody can determine from here.

### Content archive

`POST /api/content/:id/archive` moves a post out of the default Queue. The
explicit Archived filter still lists it, and `GET /api/content/:id` still shows
its saved text, versions, adaptations, and publication receipts. Archive refuses
an item with a manual, scheduled, queued, or publishing delivery; the editor
must finish or cancel that delivery first. The API takes adaptation locks before
the item lock, and a stale publish job checks the archived parent before claiming
a send. `POST /api/content/:id/restore` reinstates the saved prior status and
clears the archive marker. Restore does not enqueue a publication. Both calls
are idempotent and scoped to the active organization. Permanent deletion is a
separate operation: `DELETE /api/content/:id` accepts only archived posts whose
previous status was Draft or Rejected and whose adaptations have no delivery
attempts or publication records. Existing posts remain protected because past
channel deletions may have severed their receipt links; a database marker
tracks that risk for posts created after the deletion-safety migration. Posts
with a retained generation run are protected because its checkpoints contain
draft text. Eligible posts lose their saved versions, notes,
review links, feed entries, and adaptations with their database cascades. Model
usage retains its accounting rows with a null post link.
Published posts stay in the archive because their publication receipts must
remain attributable; broader deletion needs a durable receipt provenance or
tombstone design. The UI confirms the irreversible action before calling it.

### Dated topic planning

An editor can give a topic a target date and priority without approving its
brief. The separate `autoPlanTopics` brand setting is off by default and can be
enabled without direct autopilot generation. On its hourly scan, the worker
considers only approved topics dated within the next 14 days, in the brand's
time zone. It places a snapshot of the reviewed topic and selected channels in
a 10:00 local calendar slot, highest priority first, while counting both manual
and automatic slots against the configured daily planning limit. A past 10:00
instant is skipped. Manual and automatic planners serialize on the brand, then
the topic, and refuse to place an already linked topic again. An editor must
remove an unstarted slot before changing that topic's target date or priority;
removing or unlinking the slot clears the target date so the worker does not
recreate it. Calendar generation still checks the topic revision and approval
before spending the organization's key. Drafts remain in human review and are
never published by this planner. Direct autopilot generation skips dated topics.

### Saved text history

The editor reads whole-body `content_versions` only when its Version history
disclosure opens. `GET /api/content/:id/versions` lists the master draft;
`?adaptationId=` lists one channel's text. Both return up to 20 rows, newest
first, with the next version ID in `X-Next-Cursor`. Refine fragments are excluded
because they are not complete drafts.

`POST /api/content/:id/versions/:versionId/restore` requires the currently saved
body as `expectedBody`. A newer edit returns `version_changed` (409), so an old
browser tab cannot overwrite it. The usual item and adaptation edit locks still
apply. A successful restore records a new human version; it does not rewrite an
earlier row or claim that the model's original text was written by a person.
The editor also requires local unsaved text to be saved before restore.

Generated drafts have an initial AI version. A manually created draft currently
gets its first history row on its first body edit, so the creation text has no
restorable snapshot. Clearing a channel override also creates no row because a
version body cannot be null. Both limits follow the existing version writer;
future history work should address them deliberately rather than synthesize a
body that was never saved.

### Re-adapting a channel in the editor

`POST /api/content/:id/adaptations/:adaptationId/readapt` asks the configured
BYOK model to rewrite the saved master post for one channel. It sends the
current channel text as context when present. The response is stored in
`adaptation_proposals`, one immutable proposal per adaptation, and returned
with the item on reload. The model call runs outside any row lock; every
physical call is recorded in `usage_ledger` with the content item, adaptation,
and channel. Refinement and re-adaptation share the editor's hourly allowance.

Accept uses only the stored model answer. Under the adaptation and item locks,
it checks that both source texts still match those shown to the model, updates
the channel body and its AI origin, and appends a full AI version. If either
source changed, it returns `readapt_source_changed` and keeps the paid
proposal for review or discard. A newer request supersedes the old proposal
with a new ID; a failed request leaves the existing proposal intact. Discard
never changes the channel text. Published or in-flight adaptations cannot be
re-adapted until the existing edit rules make them editable again.

## The rules that cross package boundaries

Each of these is enforced somewhere specific. If you change one, find every
enforcer — the project's history is a list of holes opened by changing one copy.

| Rule | Enforced in | Pinned by |
|---|---|---|
| Nothing publishes that no human opened or touched | `ContentRepository.requireHumanInvolvement`, over `adaptations.body ?? content_items.body` | `content.e2e.spec.ts` gate tests; mutation |
| Is every sentence still the model's — one question, two grains | `shared/provenance.ts`: `allSentencesAi` (gate + badge), `aiSentenceMaskAny`/`dimSpans` (lens) | `provenance.test.ts`; the gate's ordering tests |
| A fragment records what it replaced (`unit_delta`) | written once by `planRefineAccept`, CHECK in db | `refine-merge.test.ts`; `schema-invariants.test.ts` |
| The refine verb set is closed and declared once (`REFINE_VERBS`) | the CHECK on `refine_proposals.verb` (`packages/db/src/schema/refine.ts`), the step's `Record<RefineVerb, …>` role lines (`refine.step.ts`), the web's verb `Menu` | `content.test.ts` (shared); `refine.step.spec.ts`; `messages-parity.test.ts`; `migrate.test.ts` |
| One row in `usage_ledger` per physical model call, with an honest outcome | `ai/usage.ts` inside the SDK's retry loop; `outcome` column | `generate.test.ts`; ledger experiments in `ai-credentials.e2e.spec.ts` |
| The spend figure is exact, estimated, or "at least N unpriced" — same rule in SQL and TS | `AiCredentialsRepository.spend()` and `shared/cost-display.ts` | a test runs both over the same rows |
| Every model call runs under the run's fence, re-taken before the call | `GenerateRepository.beginStep` / `claim` | `generate.service.spec.ts` (40 cases counting model calls) |
| A send is claimed before the platform is called; an unknown outcome is terminal, never retried | `PublishRepository.claimSend` + partial unique index; `UnknownOutcomePublishError` | `publish.e2e.spec.ts` with a local Telegram stub |
| One lock order for the product | `docs/lock-order.md`; every multi-table write | deadlock tests in `content.e2e.spec.ts` and `brands.e2e.spec.ts` |
| Every tenant read is scoped by `org_id` in the repository, not only the guard | every repository method | `tenancy-lists.e2e.spec.ts` scans controllers; cross-org tests per module |
| Every org-scoped route carries `ActiveOrgGuard`; exceptions declare a reason at the controller | `@NotOrgScoped("reason")` / `@AllowAnonymous` | the same scan |
| Every `process.env` read outside `env.ts` is declared in `turbo.json` | strict env mode strips the rest silently | `db-tier.guard.spec.ts` (parses spec files with the TS compiler) |
| The database tier of the suite cannot skip itself | the same guard, under `CI` | proven by construction, three ways |
| A refusal reaches the reader in the reader's language | `refusalBody(code)` on the api; `errorMessage(err, fallback, t)` on the web, translator required | `refusals.test.tsx` per rendered error site |
| Untrusted text never reaches `instructions` | `defineStep`; material is nonce-fenced in `prompt` | structural: `callStep` is not exported |
| Credentials never appear in a response, a log, or an error | `PUBLIC_COLUMNS` allowlists; `redactSecrets`; closed failure codes | whole-body assertions; redaction tests per shape |

## Where to look for what

- A status list: `packages/shared/src/dto/*` — the one definition; `db` imports it.
- A refusal a user sees: `packages/shared/src/dto/errors.ts`, then the four `messages/*.json`.
- Why a lock is taken in the order it is: `docs/lock-order.md`.
- What a mutation verdict does and does not prove: `docs/mutation-testing.md`.
- The UX rules a screen must keep: `CLAUDE.md` "UX constitution", then `docs/ux-patterns.md`.
- A decision's original reasoning: `docs/specs/000N-*.md` — records of decisions, not current documentation; where they have drifted from the code, an editorial note says so.
- Something that bit us and the rule it produced: `docs/lessons.md`.
