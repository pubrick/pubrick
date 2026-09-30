# Hosted recovery acceptance

Date: 2026-09-30. Baseline: `eb45358e`; fixture implementation `51c941ae` plus receipt extension `7687e4ed`.
Scope: disposable source installation recovery, not published-image installation
or a live payment/SMTP/application restart drill.

## Current-schema fixture

The old native test used a minimal handwritten draft table and queue-shaped
table. The replacement runs the maintained current migration journal, including
0124, and creates real pg-boss authentication queues. It captures and restores:

- Channel credentials and reset mail encrypted under the historical key; the
  full rotated ring decrypts them while the new key alone refuses them.
- Reset-token ownership and origin/auth identity; a different origin cannot
  make the restored message eligible. No mail is sent.
- Sandbox subscription identity, plan limits and authoritative entitlement
  revision, retained external cleanup work and an expired physical-call fence.
- Live and retained media bytes/files, terminal cleanup proof state, and a
  separate historical unknown-size proof that still requires reconciliation.
- Complete billing-event receipts with their scoped identities and attempt
  counts. A fresh primary key cannot insert the same scoped event again; the
  same event under another account remains a separate identity. These are
  synthetic durable facts, not vendor webhook or payment acceptance.

A wrong target key ring and a missing media archive are refused before database
or media mutation. The source writers resume after backup; only PostgreSQL runs
in the restored target. Controlled writer sentinels are used: the test does not
boot the application or worker, resume jobs, dispatch models or publish external
content.

## Review and cleanup corrections

Independent review required explicit ORM projections and exact volume checks.
A manually created target media volume has no Compose ownership label and can
survive `compose down -v`. A subsequent native run detected this actual fixture
cleanup defect after its recovery assertions passed (**138.42 seconds**). The
two recorded owned volumes from the preceding runs were removed explicitly.
The test now attempts cleanup for both projects, explicitly removes its owned
media volume, checks both exact media/pgdata names and container inventories,
and removes its temporary directory before reporting cleanup failures.

The corrected drill passed in **147.78 seconds** with exact cleanup proof. That
run preceded the environment-isolation follow-up and billing-receipt extension;
it is evidence for the earlier scope, not the entire final fixture.

All fixture Docker calls, including injected recovery commands and cleanup, use
a copied environment without inherited Compose or authentication/encryption
overrides. Compose and env files are explicit; file-descriptor options remain
intact and the caller environment is unchanged. A focused offline executor
regression verifies those boundaries. Production recovery code is unchanged.

## Final local evidence

The final complete source at `7687e4ed` passed **2/2 tests in 153.00 seconds**
with `PUBRICK_RECOVERY_DOCKER_TEST=1`: the offline isolated-executor regression
and the **152.65-second native recovery drill**, now including complete billing
receipts. Both exact project container inventories were empty; both exact
media/pgdata volume names were absent; the temporary directory was removed.
An interrupted retry-only receipt attempt was not counted as passing; only its
recorded owned project and temporary directory were removed.

The default root script suite passed **35 tests**, with **2 opt-in native tests
skipped**. Skips are not native evidence. Full Biome checked **994 files**; the
subsequent receipt helper received its affected-file check and whitespace checks
passed. Independent read-only review closed ORM projections, exact cleanup,
environment isolation and receipt assertions without rerunning tests or services.
No remote workflow was dispatched, no image published and no production service
changed by this acceptance work.

## Remaining launch acceptance

This fixture does not replace anonymous published-image pulls, both-architecture
installation/upgrade verification, a real vendor payment sandbox, application
login after restore or external delivery reconciliation. Those checks remain
required by the release and hosted launch procedures.
