# Outgoing webhooks

Organization owners and admins can create up to ten active outgoing webhooks with
`POST /api/webhooks`, list them with `GET /api/webhooks`, inspect the latest 100
delivery records with `GET /api/webhooks/deliveries`, and revoke one with
`DELETE /api/webhooks/:id`. The create body is:

```json
{
  "name": "Publishing automation",
  "url": "https://hooks.example.com/pubrick",
  "onSucceeded": true,
  "onFailed": true,
  "onUnknown": true
}
```

The create response shows a random `whsec_` signing secret **once**. Copy it
before leaving the response. Listing and delivery history never return the
secret or the endpoint URL. Both are encrypted at rest with the configured
application encryption key. Revocation stops future events and closes pending
deliveries; an already in-flight request may finish.

## Events and payload

The supported events are `publication.succeeded`, `publication.failed`, and
`publication.unknown`. They describe a terminal `publications` record, not an
editor's draft. A PostgreSQL trigger adds one outbox row per matching active
subscription **in the same transaction** that inserts or changes the terminal
publication status. A rolled-back publication writes no event. A unique index
prevents a repeated status write from adding the same event twice.

The JSON body is stable across delivery attempts:

```json
{
  "id": "event UUID",
  "event": "publication.succeeded",
  "createdAt": "2026-09-24T12:00:00.000Z",
  "data": {
    "publicationId": "publication UUID",
    "adaptationId": "adaptation UUID or null",
    "channelId": "channel UUID or null",
    "status": "published",
    "attempt": 1
  }
}
```

No draft body, channel credentials, endpoint URL, or signing secret enters the
payload. The `id` is the receiver's idempotency key.

## Verify a request

Pubrick sends `X-Pubrick-Event-Id`, `X-Pubrick-Timestamp` (Unix seconds), and
`X-Pubrick-Signature`. The signature is `v1=` followed by the lowercase hex
HMAC-SHA256 of `${timestamp}.${rawBody}`, keyed with the one-time secret.
Compute it on the unmodified HTTP body and compare in constant time. Reject
timestamps outside your chosen replay window and remember event IDs already
processed. A retry keeps the event ID and JSON body, but has a fresh timestamp
and signature.

## Delivery and reconciliation

The worker scans every minute, up to 25 due deliveries per scan. It claims a
row durably before sending and makes a POST with a five-second deadline.
`2xx` marks it sent. An explicit `408`, `429`, or `5xx` response can be retried
with delays of 30, 60, 120, and 240 seconds, at most five attempts in total.
Other HTTP responses mark it failed. A blocked destination or unreadable
encrypted credential also fails before sending. A timeout, connection reset,
or process crash has an **unknown** outcome and is never automatically resent.
Claims still `attempting` after ten minutes become
`unknown` on the next scan. Inspect `GET /api/webhooks/deliveries` and reconcile
such an event with the receiver using its stable ID. The history exposes
`pending`, `attempting`, `sent`, `failed`, and `unknown`, attempt count, last
known HTTP status, timestamps, and publication ID. It does not expose response
bodies or transport errors.

Even an explicit `5xx` can happen after the receiver performed its side effect,
so receivers must deduplicate by event ID. The system has at-least-once
delivery for explicit retryable responses; it does not promise exactly-once
effects. Ambiguous network outcomes are deliberately left for manual review.

Endpoints must use a public HTTPS hostname on port 443 with no embedded
credentials, query string, or fragment. Before each request, the worker checks
all DNS answers, rejects private, loopback, link-local, CGNAT, and metadata
addresses, pins the checked address at connect time, and follows no redirects.
The HTTP response body is not retained. Logs contain the event ID only, never
the destination or secret.
