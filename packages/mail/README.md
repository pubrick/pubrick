# Authentication mail boundary

`@pubrick/mail` is a server-only transport and encrypted payload contract. This
package is not yet connected to the API, worker or a durable outbox. Importing it
starts no queue, opens no SMTP connection and requires no environment variables.
Self-hosted installations retain their existing no-mail flow.

## Maintained dependencies

Nodemailer 10 owns SMTP, MIME, authentication and TLS negotiation. Zod owns strict
payload/configuration parsing. Pubrick's existing `encryptJson` / `decryptJson`
owns the authenticated encryption envelope and key ring; no second crypto format,
SMTP protocol, retry loop or queue is introduced. Later integration will use the
existing pg-boss rather than an in-memory queue or new datastore.

## Payload and current ownership

`sealAuthMail(payload, keyRing)` validates purpose/version, deadline, canonical
links and a stable Message-ID, then produces **only `{ ciphertext }`**. Recipient,
signed link, locale, target identity and delivery deadline stay inside encryption.
`openAuthMail` accepts old keys retained in the ring, rejects missing keys,
tampering and unsupported payloads, and exposes closed errors without input data.

`createMailIdentity(origin, deploymentMode, authSecret)` binds jobs to the
canonical origin, explicit self-hosted/hosted mode and a domain-separated auth
secret fingerprint. A restored job from another domain, mode or token-signing
secret is skipped. This is an instance binding, not billing authorization.

Verification and reset mail deadlines are at most one hour after creation;
invitation mail at most 48 hours. Future API integration must explicitly share
these constants with Better Auth's verification/reset expiry configuration.
The token library remains responsible for actual verification and consumption.
A queued mail deadline never extends token validity.

`createSmtpMailTransport(config, { identity }).deliver(payload, resolver)` makes
one SMTP attempt. Before every attempt, it calls the supplied **fresh authoritative
storage resolver** and rechecks the clock after that read. Current account ID and
email must still match; already verified accounts do not get verification mail.
Invitations must still belong to an existing organization, remain pending, target
the same recipient and be unexpired. Missing/deleted/changed targets are skipped.
For reset mail, the resolver must also fetch the exact Better Auth verification
identifier returned by `resetMailVerificationIdentifier(payload)`. The record
must still exist, belong to that user and be unexpired. Consuming the token
deletes this record; a consumed or deleted reset link is never mailed.
A successful previous attempt never caches ownership for a later retry.

The transport requires authenticated implicit TLS or STARTTLS with normal
certificate validation. Plaintext is allowed only for explicitly selected
`runtime: "test"` and a loopback host; production is the default. File/URL content
access and SDK logging are disabled. The four product locales are supported.

## Delivery policy for future integration

The API must await durable enqueue rather than SMTP, and return consistent generic
results on queue admission failure. It must not claim delivered mail from an
accepted submission. Queue/DLQ rows must contain encrypted payloads only and
sanitized closed failure codes, never provider errors or addresses.

pg-boss must own bounded retry attempts/backoff, distributed group concurrency,
expiry and retention. Transient/timeouts can retry; authentication/permanent SMTP
rejection needs operator action rather than endless automatic retries. Check
current ownership and deadline on every retry and discard expired links before
SMTP. Keep keys until retained queued/DLQ jobs and recoverable snapshots no longer
need them. Resume restored workers only through the existing explicit recovery
procedure.

SMTP is **at least once** under uncertainty: a server can accept a message before
a connection or worker fails. A stable Message-ID survives retries but does not
guarantee recipient/provider deduplication. Never claim exactly-once email.
This package alone is not a completed durable delivery or hosted SaaS service.

## Verification

```sh
pnpm --filter @pubrick/mail test
pnpm --filter @pubrick/mail typecheck
pnpm --filter @pubrick/mail build
```

Pure contracts test encryption/key rotation, invalid/cross-instance/stale payloads,
current ownership, deadlines, stable IDs and sanitized transport failures with
an isolated SDK mock. They make no network requests and use synthetic secrets.
Existing API transport tests separately exercise a real loopback SMTP capture;
queue restart/recovery/consumer tests belong to the integration slice.
