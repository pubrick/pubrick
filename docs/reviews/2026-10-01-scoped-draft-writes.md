# Scoped draft writes: integrated verification

Date: 2026-10-01 (Europe/Moscow).
Integrated production source: `33a07551`; final QA and packaging accompany
this record. Feature branch: `codex/hosted-platform`. Main release is pending.

## Delivered scope

V2 supports imported draft creation, queued generation with explicit paid BYOK
consent, narrow generation status, and imported draft reads. Dedicated
operation scopes, immutable idempotency acknowledgements, tenant authority,
bounded request limits and lifetime replay records are enforced in the API.
The maintained generation pipeline owns queue consumption and per-call costs.
Known totals identify price-table estimates; incomplete costs remain unknown.

MCP exposes these operations only with explicit v2 configuration and dedicated
write keys. Settings explains organization-wide authority and the consequence
of revocation for already admitted jobs. Neither API nor MCP approves or
publishes a draft. Imported text retains a human-review obligation and neutral
provenance; v1 retains its existing representation and cursor contract.

## Integrated local gate

The final command succeeded:

```sh
pnpm typecheck && pnpm lint && pnpm test --continue=always --concurrency=2
```

Observed tails:

```text
typecheck: Tasks: 20 successful, 20 total; Cached: 17 cached
lint: Checked 1015 files. No fixes applied.
node scripts: tests 38; pass 35; fail 0; skipped 3
tests: Tasks: 20 successful, 20 total; Cached: 18 cached
```

Package test results: search 9, Telegram 32, shared 501, billing 88, MCP 32,
integrations 134, database 94, AI 434, mail 23, web 1,521, worker 252 and API
388 passed. The ordinary root command did not enable database/billing test
URLs: database 120, worker 369 and API 844 tests were intentionally skipped.
Cached unaffected package results were reused; this is not a fresh execution of
every database tier.

Earlier integrated runs failed on stale MCP CLI artifacts, repository-boundary
initialization in a unit fixture, untranslated authorship claims and controller
scanner assumptions. Fixes preserve production behavior and assertions: MCP
builds its CLI before stdio tests, the knowledge unit fixture substitutes its
repository DI token, refusal copy avoids unsupported claims, and each public
controller has its own file. The v2 content list now participates in the
existing native tenant-list fixture rather than receiving a scanner exemption.

## Native and browser acceptance

The backend author exercised actual HTTP admission, PostgreSQL, pg-boss
consumption and the maintained generation service with the scripted model.
Generation produced an AI draft and multiple metered physical-call rows; it
was not simulated by marking a run finished in the database. Focused follow-up
checks verified provider-reported versus estimated cost, unknown legacy cost,
tenant paging and controller coverage. Owned disposable databases were removed.
Migration 0125 also received independent review and native migration checks.

`node scripts/e2e/run.mjs` succeeded against compiled API and production-built
Next: two journeys passed, with the separately hosted journey intentionally
skipped. The new journey issues keys through Settings, imports concurrently
from a cookie-free client, checks scope refusal, v1 exclusion, conflict handling,
opens and edits the draft in the owner browser, reloads saved edits, replays the
original acknowledgement without replacing edits, and revokes the writer.
It makes no provider, publishing or worker calls. Both disposable journeys
clean up their owned services and data.

The browser exposed misleading Refine copy that described imported text as
manually authored. Four localized UI regressions reproduced this and the
copy now says Refine is available for AI-generated drafts.

## Independent authority review

Combined review covered transaction lock ordering, fresh authority, replay and
key replacement, projections, failure limits, consent, imported approval gates,
MCP transport and backward compatibility. No unresolved P1 or approval bypass
was reported.

A separate native mutation probe held admission waiting, revoked an initially
authorized key, and then released admission. Three baseline runs passed.
Removing only the transaction's fresh revoked-key condition produced the same
failure in all three mutant runs: expected refusal 403, actual creation 201.
After restoration the baseline passed again. This pins that one transaction
check; it does not prove all locks, all authorization paths or a full package
verdict. The review checkout was restored and its database removed.

## Docker context isolation

Actual generated `.data/browser-tests` artifacts revealed missing Docker
context exclusions. `.dockerignore` now excludes root and nested local data
and environment files, preserving configuration examples. The opt-in native
Docker COPY probe passed using only synthetic files and `FROM scratch`; it
never copied the operator checkout or downloaded a base image.

## Remaining release limits

Main merge and public image release remain pending explicit authorization.
The public multi-architecture install/upgrade and commercial payment/operator
configuration are separate acceptance requirements. Browser journeys use
isolated accounts and cannot establish a successful session in the user's
in-app browser, whose automation transport was unavailable. The previously
verified saved Google connection is separate provider evidence.
