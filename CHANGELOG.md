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

### Changed
- Migrations run under a Postgres advisory lock, so parallel test workers and multiple api replicas can no longer race each other on a fresh database.
- Compose has no fallback values for `BETTER_AUTH_SECRET` / `APP_ENCRYPTION_KEY` — an install without them fails immediately instead of shipping the repo's published key; the api port is bound to `127.0.0.1` (the web app proxies `/api`).
- `APP_ENCRYPTION_KEY` is validated at boot (base64 → exactly 32 bytes) rather than at first channel create.
- Channel form asks for each platform's real credential fields (all 8 platforms), masks secrets, and clears entered values when the platform changes.
- Organization slugs handle non-Latin names; onboarding stops on a failed `setActive`.
- API errors surfaced by the web app no longer leak raw Nest JSON; a 403 with no active organization sends the user to onboarding.
