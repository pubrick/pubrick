# Changelog

All notable changes to this project are documented here.
Format: [Keep a Changelog](https://keepachangelog.com/), versioning: [SemVer](https://semver.org/).

## [Unreleased]
### Added
- Monorepo scaffold: web / api / worker apps, db package, docker compose, CI.
- Auth: Better Auth email/password sign-up and sessions, proxied through the web app at `/api/auth/*`.
- Organizations: create/set-active, org-scoped tenancy (`org_id` on every tenant table).
- Brands: org-scoped CRUD with zod validation.
- Channels: org-scoped CRUD with AES-GCM encrypted credentials (`encryptJson`/`decryptJson`), never returned by any endpoint.
- Channel connection test endpoint: verifies Telegram credentials (`getMe`/`getChat`/`getChatMember`) without publishing anything.
- Content: drafts with per-channel adaptations, a review queue (approve/reject, immediate or scheduled), and body/adaptation overrides.
- Publishing: a Telegram adapter and a pg-boss-backed worker that publishes approved adaptations, classifying platform errors as permanent (recorded as `failed`, job completes) or transient (rethrown for pg-boss to retry), plus a DLQ consumer that terminates adaptations whose retries are exhausted.
- Env wiring for auth/crypto/publishing through turbo, CI, docker compose, and `init.sh`; self-hosting docs for `BETTER_AUTH_SECRET` / `APP_ENCRYPTION_KEY` / `PUBLIC_ORIGIN` and connecting a Telegram channel.
- Brand identity: wordmark (light/dark), brick mark and 1280×640 social card in `assets/`; README header with scheme-aware logo and badges; web favicon (`app/icon.svg`), inline `Logo` component on the landing page, and the palette as CSS custom properties in `app/globals.css`.
- Navigation between brands and the content queue (the landing page links to both), so the review-and-publish flow is reachable without typing a URL.

### Changed
- Migrations run under a Postgres advisory lock, so parallel test workers and multiple api replicas can no longer race each other on a fresh database.
- Compose has no fallback values for `BETTER_AUTH_SECRET` / `APP_ENCRYPTION_KEY` — an install without them fails immediately instead of shipping the repo's published key; the api port is bound to `127.0.0.1` (the web app proxies `/api`).
- `APP_ENCRYPTION_KEY` is validated at boot (base64 → exactly 32 bytes) rather than at first channel create.
- Channel form asks for each platform's real credential fields (all 8 platforms), masks secrets, and clears entered values when the platform changes.
- Organization slugs handle non-Latin names; onboarding stops on a failed `setActive`.
- API errors surfaced by the web app no longer leak raw Nest JSON; a 403 with no active organization sends the user to onboarding.
- Rejecting an approved item now actually cancels delivery: every queued or scheduled adaptation goes back to `pending` and its pg-boss job is cancelled in the same transaction, and the worker refuses to publish a job whose content item is rejected.
- A scheduled post can be rescheduled or published immediately: approving an already-scheduled item cancels the outstanding job and enqueues a fresh one at the new time instead of returning 200 and changing nothing.
- The publish queue contract (names, options, job payload) lives in `@pubrick/shared` and is imported by both the api and the worker, instead of being duplicated in each.
- The publish queue sets `heartbeatSeconds`, and its expiry is a bound on a whole attempt rather than a liveness check, so a live handler is no longer reclaimed and re-run (a duplicate post).
- The worker validates stored credentials against the adapter's schema before sending, so a malformed channel gives a named field error instead of an opaque platform 400.
- `PATCH /content/:id` rejects an empty body with 400 instead of 500, and `scheduledAt` must be in the future.
- Errors on the content screens distinguish what the operator can act on: a 4xx is shown as the server phrased it, while a 5xx or a failure with no HTTP status at all (network, proxy error page) becomes a translated "something went wrong" instead of raw English.
- A published link is rendered as a link only when it is `https://`; anything else is shown as inert plain text, since the URL comes from a platform adapter rather than from this app.
- The approve/reject buttons are disabled, with the reason spelled out, on an item that has already been published.

### Fixed
- The database now bounds publication bookkeeping: a partial unique index allows at most one `published` publication row per adaptation, and the worker checks for one before sending. This makes a re-delivered or re-approved job a no-op; it does not make a duplicate *post* impossible, since the send happens between that check and the record (a process killed in between leaves no record and a later attempt sends again).
- A late dead-letter delivery no longer clobbers a re-approved adaptation — `markExhausted` acts only on an adaptation still in `publishing`.
- Rejecting an item whose delivery is mid-attempt (`publishing`, e.g. part-way through a transient retry chain) no longer strands it: the adaptation goes back to `pending` and its job is cancelled, so it can be approved again.
- A publication that is already recorded no longer reports as a recording failure — the worker converges the adaptation's status instead of retrying a write that can only violate the unique index again.
- `getPublisher` no longer returns inherited `Object.prototype` members (`getPublisher("constructor")` was truthy but not a publisher).
- Approval now pins the content. Editing an item's body or a per-channel override after approval returned 200 while the adaptation kept its live job, and the worker reads the body at execution time — so unreviewed text was what actually published. Both edits are refused with 409 ("reject it first") once the item leaves `draft`/`rejected`.
- Approve and reject on an already-published item are refused with 409 instead of permanently storing `approved`/`rejected` over `published` — a status nothing repaired, since `recomputeItemStatus` only runs from the worker.
- Rejecting an adaptation clears its `lastError`, so a rejected row no longer shows the previous attempt's platform failure.
- `lockAdaptations` orders its `SELECT … FOR UPDATE` by id, so two concurrent approves of one multi-channel item cannot lock its rows in opposite orders and deadlock (a 500 on a merely duplicated request).
