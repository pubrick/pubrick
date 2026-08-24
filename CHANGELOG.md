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
- Env wiring for auth/crypto through turbo, CI, docker compose, and `init.sh`; self-hosting docs for `BETTER_AUTH_SECRET` / `APP_ENCRYPTION_KEY` / `PUBLIC_ORIGIN`.
