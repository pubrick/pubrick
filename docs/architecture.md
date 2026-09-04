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
`schema-invariants.test.ts`. Sixteen tables in four files: `auth.ts` (better-auth:
user, session, account, verification, organization, member, invitation),
`content.ts` (brands, channels), `content-items.ts` (content_items,
adaptations, publications), `generation.ts` (ai_credentials, pipeline_runs,
usage_ledger, content_versions).

**`packages/ai`** — every model call in the product. `defineStep` is the only
way to make one and is what keeps the untrusted-text boundary, the schema sent
to the model, and the ledger attribution from drifting apart. Five pipeline
steps live in `steps/`; the metering (`usage.ts`), the call budget
(`budget.ts`), the failure classifier (`classify.ts`) and the price table
(`pricing.ts`) are shared by every caller.

**`packages/integrations`** — publishers, one per platform, behind a registry
typed over the platforms `shared` declares as publishable. Today: Telegram. A
publisher's errors are one of three kinds — permanent, transient, or unknown
outcome — and that distinction is the whole delivery story (below).

**`apps/api`** — NestJS, one module per domain (`brands`, `channels`, `content`,
`runs`, `ai-credentials`, `org`, `queue`, `health`). Controllers never touch the
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

## The rules that cross package boundaries

Each of these is enforced somewhere specific. If you change one, find every
enforcer — the project's history is a list of holes opened by changing one copy.

| Rule | Enforced in | Pinned by |
|---|---|---|
| Nothing publishes that no human opened or touched | `ContentRepository.requireHumanInvolvement`, over `adaptations.body ?? content_items.body` | `content.e2e.spec.ts` gate tests; mutation |
| Is every sentence still the model's — one question, two grains | `shared/provenance.ts`: `allSentencesAi` (gate + badge), `aiSentenceMaskAny`/`dimSpans` (lens) | `provenance.test.ts`; the gate's ordering tests |
| A fragment records what it replaced (`unit_delta`) | written once by `planRefineAccept`, CHECK in db | `refine-merge.test.ts`; `schema-invariants.test.ts` |
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
