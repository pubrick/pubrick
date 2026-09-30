# Hosted identity development

This slice implements verified email ownership and recovery. Hosted application
startup now also binds the validated billing and atomic workspace admission modules;
this remains a sandbox development stage, **not a complete live subscription service**. Do not announce a paid SaaS or expose this stage as
an unlimited public service. Billing admission, trial/organization admission,
quotas and reconciliation are implemented on the integration branch. External
payment sandbox verification, public legal/support policies and hosted operations
remain launch requirements in [the hosted beta design](plans/hosted-beta.md). The billing slice
must refuse missing hosted billing configuration before public deployment.

## Modes

`PUBRICK_DEPLOYMENT_MODE=self-hosted` is the default. With no SMTP configuration,
first-account bootstrap, invite-only registration afterwards and manually shared
invitations keep their existing behavior. Email ownership is not asserted on such
an installation. A configured optional mail transport enables recovery and mailed
invitations; it does not change the self-hosted registration policy or require
verification for existing users.

`PUBRICK_DEPLOYMENT_MODE=hosted` requires:

- Explicit `SIGNUP_MODE=open` and enabled auth rate limiting.
- Complete operator billing configuration as described in [hosted billing](../apps/api/src/billing/README.md). Missing billing configuration refuses hosted startup, including local tests. There is no identity-only runtime bypass.
- Matching `WEB_ORIGIN` / `BETTER_AUTH_URL` origins (Compose derives both from
  `PUBLIC_ORIGIN`). HTTPS is required when `NODE_ENV=production`, as in the API image.
- An operator-configured SMTP host, authentication credentials and sender address.
- Implicit TLS or required STARTTLS. TLS certificate validation is retained; there
  is no production option to silently trust an invalid certificate or use plaintext.

Example operator configuration, replacing every example value privately:

```dotenv
PUBRICK_DEPLOYMENT_MODE=hosted
SIGNUP_MODE=open
PUBLIC_ORIGIN=https://pubrick.example
SMTP_HOST=smtp.example
SMTP_PORT=587
SMTP_USER=pubrick
SMTP_PASSWORD=configure_privately
SMTP_FROM=pubrick@example.com
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
```

For port 465 implicit TLS, set `SMTP_SECURE=true`. Configure a verified sending
domain and the mail provider's recommended DNS records. Never put SMTP credentials
in workspace settings, browser bundles, Git, issue reports or application logs.
The SMTP host is trusted operator configuration; users cannot choose it.

## Ownership and user flow

Better Auth owns verification and recovery tokens. Existing auth tables already
store verification state and reset tokens; no parallel token store is introduced.
Nodemailer sends SMTP requests from the worker; pg-boss bounds durable admission
and delivery concurrency as described below. Verification, recovery and invitation
messages support the four UI locales; destination links are limited to the
configured canonical origin and the supported auth/onboarding routes.

Hosted signup creates an unverified account without issuing a session. The UI
shows a check-email state with resend and sign-in actions. Sign-in refuses an
unverified address, and invitation acceptance requires ownership verification.
Verification itself does not auto-sign in: the user returns to sign-in after
opening the confirmation link. Resend and recovery endpoints use bounded rate
rules. Signing in does not automatically send another confirmation message.

Password recovery responds generically for known and unknown addresses. SMTP
failure does not change that response into an existence oracle. Auth callbacks
return before SMTP transport I/O, including when admission is full, so provider
latency does not distinguish known recipients from unknown ones. Delivery failures
are logged without recipient addresses, credentials or signed links; operators
must monitor those events and the mail provider's delivery status. The user sees
an actionable invalid/expired-link state and can request a new link. Successful
password reset revokes existing sessions; a consumed reset token cannot be reused.

The ownership policy covers server-side sessions and raw Better Auth organization
mutations, not just hidden buttons or the login form. Hosted sessions bypass the
cookie cache and consult authoritative ownership. When changing an existing
self-hosted installation to hosted mode, unverified old sessions cannot create
workspaces, change email or access tenant routes. Their users need to confirm
ownership of the registered address first; mail verification does not delete data.

## Operations and limitations

This is an identity development mode pending the remaining hosted admission and
billing work. The current Better Auth limiter is per API process; a horizontally
scaled hosted service also needs a durable shared admission layer or correctly
configured ingress limits. Configure `TRUSTED_PROXIES` only for the actual ingress
proxies; do not trust caller-supplied forwarding headers indiscriminately. A
verification email proves mailbox control, not a user's legal identity.

Authentication mail is an encrypted pg-boss outbox. API callbacks await committed
queue admission; only the worker opens SMTP connections. A neutral response
means the request was handled, not that a message was delivered. If enqueue is
unavailable, sanitized admission diagnostics are logged and users can retry or
resend. Better Auth account, invitation and recovery-token writes occur before
mail callbacks; they are not rolled back when the outbox is unavailable.

The queue allows at most four attempts, with bounded backoff and four concurrent
SMTP jobs across all worker replicas. Every attempt checks current ownership,
exact recovery-token existence/expiry, invitation status and the signed link's
expiry. Verification/reset links last at most one hour; invitations at most 48
hours. Changing email, consuming a reset token or deleting a workspace prevents
obsolete delivery. Queue data contains only ciphertext; logs and job outcomes
contain closed codes and job IDs. Failed mail is never automatically resent from
the dead-letter queue. Operators repair SMTP and users request fresh links.

Queue admission serializes a retained-row count and insertion under one database
transaction lock. Admission refuses at 1,000 retained main/dead-letter rows.
Automatic dead-letter copies can temporarily amplify storage to at most twice
this limit; this is not an exact 1,000-row storage cap. Main waiting jobs are
retained at most 48 hours, terminal rows one hour; dead letters one hour. pg-boss
maintenance removes expired rows. Deadline checks independently prevent sending
expired links before maintenance runs.

Graceful API shutdown closes admission before draining committed writes; worker
shutdown waits for pg-boss jobs before closing SMTP. Restores retain encrypted
jobs and keep workers stopped until the operator explicitly resumes them.
Jobs restored under another origin, deployment mode or token-signing secret are
skipped. Preserve encryption-key history while retained jobs/snapshots need it.

SMTP has at-least-once uncertainty: acceptance followed by a lost connection or
worker crash can cause a retry. Stable Message-ID helps identify retries but does
not guarantee recipient deduplication. This does not establish SaaS readiness.

SMTP availability and deliverability are operator dependencies. An SMTP outage
leaves users unable to verify/recover; no fallback silently grants access. For an
isolated local test only, a loopback SMTP capture may use plaintext with
`NODE_ENV=test` and `SMTP_REQUIRE_TLS=false`; production refuses this configuration.
Local transport tests also prove that a transport requiring STARTTLS refuses a
capture server that does not offer it. No test sends live email.

Focused checks cover configuration refusal, canonical links, real local SMTP,
translated UI, unverified legacy cookies, verified invitations, consumed recovery
tokens, revoked sessions and non-enumerating SMTP failures. Run the database
identity tier against a disposable Postgres via `TEST_DATABASE_URL`, never against
an installation containing user data. A hosted beta still needs a full external
signup → subscription → first-draft journey and recovery rehearsal before launch.

## SDK organization boundary

In hosted applications, raw Better Auth organization creation, invitations, resend,
acceptance/rejection/cancellation, member addition/removal, role changes, leaving and
deletion return `HOSTED_ORGANIZATION_MUTATION_REQUIRED`. Use Pubrick's custom
workspace actions, which verify ownership, serialize limits and enqueue mail or
external cleanup in the domain transaction. Read-only organization/invitation
lookups, setting the active organization and manager-authorized name/slug updates
remain SDK operations. Server-only `auth.api.addMember` is also denied by the
SDK's operation ID; an unknown future organization writer stays closed. Self-hosted
SDK organization operations retain their existing behavior.

Identity integration fixtures must configure a local, operator-owned fixture catalog
and use custom workspace routes. Invitations require a seeded or independently
verified active entitlement; no trial is automatically granted. Fixture payments
are restricted to loopback nonproduction operation, and sandbox capability flags
explicitly avoid a live-payment claim.

## Operator billing environment

Compose passes the complete billing configuration to the API and only
`BILLING_DRIVER`/`BILLING_ACCOUNT_ID` to the worker for the same authoritative
quota identity. Payment secrets never reach the worker or web. Self-hosted mode
requires none of these fields; blank optional values are treated as absent.

Hosted mode requires `BILLING_DRIVER=stripe-sandbox`, the operator's
`BILLING_ACCOUNT_ID`, test secret/webhook keys, `BILLING_CATALOG_JSON`, and positive
`BILLING_MAX_OWNED_WORKSPACES`/`BILLING_MAX_CREATES_PER_DAY`. The catalog is an array
of `{id, version, priceId, limits}`; `limits` contains finite integer `seats`,
`brands`, `channels`, `mediaBytes`, and `concurrentJobs`. Seats must be positive;
other limits may be zero. Price IDs must belong to that configured account's
active recurring test prices. No price, plan or domain is supplied by default.
Optional SDK, tick and sweep budgets use validated defaults when blank.

Initial trials are explicitly disabled. This iteration is BYOK sandbox
infrastructure: users supply AI credentials and no generation credit is included.
A local integration fixture can choose `BILLING_DRIVER=fixture` with an explicit
`BILLING_FIXTURE_PRICES_JSON` and matching catalog. It must use a loopback origin
and nonproduction API process. Production containers reject the fixture driver.
Native ownership tests seed an active sandbox entitlement after creating an
empty workspace; this is test setup, not payment settlement evidence.

### Legacy SDK metadata limitation

Pubrick's custom hosted lifecycle, billing and guarded resource routes combine
roles across existing duplicate membership rows. The remaining allowed Better
Auth name/slug update endpoint reads one membership row using the SDK adapter.
An author row preceding a separate owner row can therefore receive a false 403
on that metadata update; an ordinary single owner row works. Self-hosted raw SDK
organization operations have the same adapter limitation. No legacy rows are
removed automatically. This limitation does not authorize raw hosted lifecycle
writers or widen member permissions.
