# Provider and hosted foundation verification

Date: 2026-09-30. Predecessor: `5a10f0ee` (release foundation).

## Delivered scope

- Maintained AI SDK adapters for direct OpenAI, Anthropic and DeepSeek keys,
  alongside Google and OpenRouter. Direct endpoints are fixed. Optional
  structured-output fields retain local validation and metered repair.
- Hosted email verification, invitation continuity and one-use password
  recovery through Better Auth, with bounded Nodemailer delivery and private
  configuration. Self-hosted defaults remain supported.
- Server-only billing drivers using the official Stripe SDK in sandbox and a
  deterministic offline fixture. Account identity, recurring price facts,
  checkout/invoice relationships and explicit cancellation have closed contracts.
- Four-language public product/hosting page, preserving authenticated entry
  points and stating that the paid hosted offering is still in development.

These are foundations, not an activated paid service. Billing routes,
subscriptions, durable receipt processing, quotas and hosted deletion are not
wired into the application by this milestone. Authentication mail still uses
bounded in-memory delivery; the separately developed durable-mail package has
not been integrated here. Explicit workspace text-provider selection and pinned
run credentials are the next provider slice.

## Local gate

The integrated gate at `110d3ecf` passed the complete workspace build,
typecheck, browser-runner typecheck, lint and Node script tests. The workspace
suite passed billing (57), Telegram (32), shared (471), search (9), integrations
(134), AI (399), MCP (16) and web (1,470). Four database suites exhausted their
unchanged 10-second migration setup hooks under default file concurrency;
117 tests passed and 11 were skipped after those setup failures. This initial
command failed, and is not reported as an all-green run.

The full database tier then passed **128 tests in 13 files** with
`--no-file-parallelism`, against the same disposable PostgreSQL and with the
same hook limits. The checked-in DB configuration now uses that file policy.
The remaining backend tiers passed **1,003 API tests in 83 files** and
**563 worker tests in 43 files**, including hosted auth against local SMTP.

Independent review reproduced fixture checkout/customer ID collisions with
seeded ownership facts. Separate red regression commits preceded allocation
fixes. Subsequent account/price/cancellation contracts and those fixes passed
**77 billing tests in three files**, plus billing build and typecheck.

The final affected web checks passed **41 tests in four files** (landing,
locale parity and auth forms), web typecheck and full lint (827 files).
A compiled API/production Next browser journey passed registration, workspace
creation, brand/channel/manual draft, persisted edits, review controls and
EN/RU workspace isolation. It enters through the public landing page, verifies
the installation link and checks mobile horizontal overflow. Desktop/mobile
screenshots were visually inspected. Browser stack artifacts were disposable;
no real content publication, paid model calls or live mail/payment operations
were used. Public-page and hosted-identity changes received separate read-only
reviews.

## Remaining acceptance

The manual release workflow has not published a version or images. Live seller,
payment account, domain, plans and operating policies are owner configuration,
not inferred by these sandbox adapters. Direct-provider costs remain unknown
where the provider did not report them. Vertex and custom compatible endpoints
remain separate planned adapter work.
