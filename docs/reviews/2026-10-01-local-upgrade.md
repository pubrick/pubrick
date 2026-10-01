# Local operator upgrade verification

Date: 2026-10-01 (Europe/Moscow).
Application source: `0e040031fda8ef30bb01b91146af00b86d82e2ca`.

## Observed deployment

The existing local self-hosted installation was still running older compiled
artifacts: its API migration journal stopped at `0116`, and its applications
did not contain the current hosted admission or provider integration changes.
Changing the checkout had not updated these Docker images.

A private database/media/configuration snapshot was created outside the checkout
before replacement. Its manifest checksums were verified. Encryption and auth
secrets were retained; the PostgreSQL container and durable volumes were not
recreated. The old worker's missing authentication-mail secret was supplied from
the existing operator configuration before the backup.

## Build and cutover

The initial cold Docker build failed on an npm tarball connection reset. A
successful retry used temporary build-only API/web Dockerfile overrides with a
shared pnpm cache, four concurrent downloads and five fetch retries. Application
source, lockfile and runtime Compose configuration remained unchanged.

All three application images built successfully. The old API, worker and web
were stopped before the new API applied migrations. The new API was started
with `--no-deps --no-build --pull never --wait`; worker and web were started only
after its health check passed.

Checks against the upgraded installation:

- `/api/health`: HTTP 200, `status: ok`, application version `0.1.0`.
- Database: 124 migration rows; maximum timestamp `1790792433847` matches the
  source journal's latest entry, `0124_nice_mister_fear`.
- `/ru/settings`: HTTP 200. This is route availability, not an authenticated
  interactive browser check.
- Compiled API: hosted admission controller and request authority interceptor
  present. Compiled worker: `MediaCleanupService` present in its runtime bundle.
- Operator status: self-hosted mode, one running API, worker and PostgreSQL
  container; unknown media-size count zero. Billing remains unconfigured.

## Saved Google connection

The existing `AiCredentialsRepository.test` operation was invoked inside the
upgraded API container against the sole existing Google workspace credential.
This used the repository's saved credential, proxy, model selection, call
admission, error classification and usage accounting. It did not bootstrap a
second application or change saved credentials/settings.

The real provider probe returned `ok: true` and model `gemini-3.8-flash`.
No key, proxy password, provider payload or raw exception was printed. This
confirms that this installation's saved Google connection worked at the time of
the check; it does not certify every provider, model or generation workflow.

## Cleanup and limits

The old application image IDs were no longer present after replacement. The
explicitly owned temporary pnpm cache was removed, reclaiming 1.074 GB, and the
temporary build overrides/probe script were deleted. Current application images,
durable data and the private recovery snapshot were retained. Other projects'
Docker resources were not pruned.

The in-app browser automation transport repeatedly timed out before obtaining
the existing tab's DOM. No login reset, fabricated session or publication was
performed. The earlier disposable
[browser acceptance](2026-09-30-release-foundation.md) remains separate evidence.
This upgrade does not establish public image/release availability, real payment
sandbox acceptance or hosted commercial launch readiness.
