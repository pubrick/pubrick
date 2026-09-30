# Hosted identity development

This slice implements verified email ownership and recovery, **not a complete
hosted subscription service**. Do not announce a paid SaaS or expose this stage as
an unlimited public service. Billing admission, trial/organization admission,
quotas, reconciliation, public legal/support policies and hosted operations remain
requirements in [the hosted beta design](plans/hosted-beta.md). The billing slice
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
Nodemailer sends SMTP requests; maintained p-limit controls four concurrent
deliveries with at most twelve admitted submissions per API process. Verification, recovery and invitation
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

Mail submissions are best-effort in memory, not a durable outbox. Restart or
shutdown can discard queued submissions; graceful shutdown cancels waiting tasks
and waits for active bounded transport requests. Users can resend confirmation or
recovery links. Durable encrypted mail delivery and operational retry monitoring
are required by the future hosted operations slice.

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
