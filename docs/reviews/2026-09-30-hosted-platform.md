# Hosted platform integration — 2026-09-30

This feature milestone follows `hosted-foundation`. It is not a commercial
launch and does not change production `main`.

## Integrated capabilities

- Explicit workspace text-provider selection and immutable credential provenance
  on new generation runs. Legacy checkpoints without identifiable credentials
  refuse paid execution rather than borrowing a current key.
- Vertex and guarded OpenAI-compatible BYOK adapters, alongside existing direct
  providers. Replacement keys, tenant permissions and physical-call accounting
  are exercised using local transport fixtures, without paid provider calls.
- Durable encrypted authentication mail through the shared PostgreSQL outbox and
  worker. Invitation writes can enqueue mail in their existing transaction;
  retries retain a stable message identity and recheck current token ownership.
- Manager-only workspace export: explicit tenant field allowlists, original media,
  file hashes and a complete archive manifest. A private bounded staging archive
  finishes its database snapshot before HTTP delivery. A dedicated Next route
  avoids the short rewrite proxy timeout. Private archive retention is bounded;
  exports exclude authentication secrets and billing operational state.
- Identity-scoped sandbox billing persistence: immutable catalogs, verified receipt
  inbox, checkout recovery, fair subscription reconciliation and durable external
  cleanup obligations. Configuration validates the operator account before HTTP
  readiness. Persisted fixture inventory refuses unsafe empty-driver restart.
- Signed webhooks use the existing Nest Express raw-body parser before JSON
  middleware, with a one MiB limit and compressed-body rejection.
- Hosted resource growth policy rejects expired access, foreign restored billing
  accounts and limits exceeded by the proposed delta. Zero-growth membership
  remains accessible after a downgrade.

## Verification and corrections

The integrated build and typecheck at `7d5584b8` passed 24 tasks. A full relevant
suite was attempted once: web 1,472 passed with two authorship-text failures;
DB 132 passed with one historical migration expectation failure; worker 572
passed with four generation fixture failures; API 1,037 passed with seven fixture
failures. Those failed commands are not reported as all-green runs.

Corrections preserved production policy: neutral export copy replaced claims of
original authorship; the historical default was pinned to its actual metadata-only
value; generation fixtures now establish real credential provenance; native mail
fixtures derive their configured origin. Focused follow-up verification follows
below. Unchanged passing tiers included shared 479, Telegram 32, search 9,
integrations 134, mail 23, AI 402, billing 83 and MCP 16 tests.

New raw webhook HTTP regressions passed 3/3; hosted growth policy passed 5/5.
Provider adapter checks independently covered API 102, worker 12 and Settings 80
cases, plus transport and database upgrade fixtures. Durable billing persistence
passed nine native DB regressions, and its runtime passed 41 focused checks plus
an inventory startup regression. No live emails, publications, payments or paid
model calls were performed.

## Remaining acceptance

Hosted API composition, resource/concurrency admission across every writer and
physical model call, deletion cleanup bindings and the hosted user journey remain
integration work. Initial trials are disabled. Seller details, domain, plans,
prices and a real payment sandbox account are operator inputs, not inferred
product values. No live paid checkout is advertised by the fixture adapter.
A real versioned release artifact and live commercial launch remain separate
acceptance gates.
