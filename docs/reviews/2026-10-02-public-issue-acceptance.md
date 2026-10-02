# Public issue acceptance — 2026-10-02

## Scope

Resolve the maintained browser acceptance gaps in GitHub #14 and refresh the
local hosted acceptance in #153. Payments remain deferred; a live SaaS domain and
server alias have not been supplied. This work does not declare a commercial
SaaS deployment or change the immutable `v0.1.0-beta.1` release.

## Changes

- Select the self-hosted and hosted specs explicitly. The shared configuration
  previously collected Evergreen and Telegram journeys whose separate ownership
  guards correctly refused the missing fixtures.
- Exercise the actual `/` locale redirect and retain cookie/workspace isolation
  and scoped API import/replay/revocation checks.
- Approve manually authored content for manual preparation.
- Add and reload a Telegram channel, then test the credentials through the real
  same-origin API and encrypted storage. Only the provider transport is synthetic.
- Start the compiled worker against the owned database. Human approval creates
  the actual publish job; a bounded loopback response latch exposes Publishing.
  Verify Published and its external receipt after reload, exactly one synthetic
  send, and cross-workspace refusal. No content status is seeded by the fixture.
- Update both verified hosted registrations to the current onboarding redirect.
  Check all five usage rows after the invited member joins.

## Browser evidence

Both runners passed against clean source
`62e0d6285709d6058f6db361a81c5cac68eae34b`, using compiled API/worker and production
Next standalone, with the reviewed PostgreSQL 16 image digest. Each runner owns
its ports, disposable database, temporary media and synthetic secrets.

- `node scripts/e2e/run.mjs`: **2 passed**; main journey and scoped-write journey.
- `node scripts/e2e/hosted.run.mjs`: **1 passed**; verification/login, workspace,
  unpaid refusal, fixture entitlement, persistent human content/knowledge,
  invitation/acceptance, usage/quotas, expiry, export and tenant deletion.
- Exactly one native send reached the **local** Telegram fixture. Manual content
  reached `manual_ready`; no real publication or model call was performed.
- Owned containers and temporary media were removed by the runners.

## Focused checks and review

Browser TypeScript checks and Biome passed. The five fixture/provenance tests
passed. An independent reviewer repeated these tests in a separate checkout;
removing control authentication and accepting a foreign chat each produced the
expected failure, then exact source was restored. Review found no actionable
safety defects. Runtime failures in the initial new scenario were corrected:
wait for brand navigation before recording its URL, use the existing channel
form, and assert the success text within its status wrapper plus the exact API
response. The completed self-hosted run is the evidence for those corrections.

The local unit gate also exposed four API suites importing validated environment
before their fixtures when no runtime variables were supplied. API setup now
provides ephemeral synthetic secrets and an unused loopback runtime URL, mirroring
the worker's existing setup. It never sets `TEST_DATABASE_URL`; the CI database
guard remains mandatory. The existing quota and guard tests pass without operator
configuration; DB scenarios still skip honestly in a unit-only run.

The integrated local gate passed: `pnpm typecheck` (20 tasks), `pnpm lint`,
and `pnpm test --concurrency=1` (20 tasks). The root script tier reported
75 passed and 3 skipped; workspace suites reported 3,698 passed and 1,497
database-dependent tests skipped. These are unit-only results, not a claim
that the full database tier ran. The browser runners above separately exercised
their owned real databases. An initial parallel run hit the shared generated
corpus test's existing five-second limit; sequential execution passed without
changing the test or its timeout. A focused independent review also found no
blocking defects in the API's test-only environment setup.

## Issue disposition

Close #14 after the verified changes are integrated. The expensive browser tier
remains manual/local. Keep #153 open: fixture subscription access does not prove
vendor checkout, signed webhooks, portal/plan/cancellation, public email delivery
or a controlled external SaaS beta. Its GitHub description now distinguishes
implemented functions and the published release from these remaining conditions.
