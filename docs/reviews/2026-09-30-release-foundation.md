# Release foundation verification

Date: 2026-09-30. Base: `7f0327b0` (reviewed main after PR #152).

## Delivered tooling

- Manual, source-validated release workflow for API, worker and web images;
  multi-platform image jobs, digest manifests and release Compose overlay.
- Consistent PostgreSQL/media/encryption-key snapshots and a paused recovery
  path. Recovery does not start workers automatically.
- Disposable Playwright journey against the compiled API and production Next
  standalone server, including account, brand, channel, draft and workspace flow.
- Explicit Settings workspace switching, authoritative reload after ambiguous
  session changes, private security reporting and contributor/recovery guides.

## Local evidence

The integrated gate at `aed85efa` passed the full workspace build, typecheck,
browser-runner typecheck and lint. Node script tests passed 21 tests; the native
Docker recovery test is opt-in and was skipped in that command. The recovery
implementation was also exercised separately with real disposable PostgreSQL
and media snapshots, including the final no-pull/empty-target round trip.

The workspace test run passed search (9), shared (471), Telegram (32), database
(127), integrations (134), MCP (16), AI (381) and web (1,456). API passed 982
tests and failed four assertions in two existing encryption fixtures. The app
used the inherited random test key while those assertions assumed the fallback
key. The fixture fix preserves real decryption, replacement and isolation
assertions; both affected files subsequently passed all 25 tests. Turbo stopped
before the worker tier on that first run; the worker tier then passed all 563
tests in 43 files. This was an initial failed integrated run plus affected
verification, not a claim that the initial command succeeded.

Independent review found and reproduced three additional edge cases: an
unowned recovery staging path being removed after an exclusive-create refusal,
a destination symlink bypassing the checkout containment check, and stale or
ambiguous workspace selection. Each has a test-first regression and fix.
Final affected checks at `188a793d` passed:

- Recovery: 16 Node tests.
- Workspace switcher, Settings and locale parity: 97 tests in three files.
- Web typecheck and production build; full repository lint (802 files).
- The two API encryption fixture files and full worker tier described above.

The actual production browser journey passed before the small selector
follow-up; those follow-ups were verified by component and typing/build checks.
The journey checks HttpOnly authentication cookies and isolation while
switching EN/RU workspaces. It does not send content to external platforms or
make paid model calls. No developer's running stack or database was reused.
Disposable test servers, containers and media were removed after verification.

## Remaining acceptance

No version tag, GHCR image publication or public release was created. The
manual release workflow has not been dispatched, so hosted multi-architecture
build execution and anonymous image pulls remain release-time checks. Source
and digest traceability do not imply byte-identical rebuilding from floating
base images. The open-source release milestone is complete only after the
explicitly versioned published artifact and installation acceptance agree.

LLM provider expansion, hosted identity and billing are separate in-progress
roadmap slices and are not delivered by this release-foundation record.
