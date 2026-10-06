# Native publication lifecycle

Date: 2026-10-06. Design for competitive-parity milestone 3; this document
does not claim that the proposed destinations are already available. Delivery
is tracked under Beads epic `Ozon-tools-zib2q` and the product roadmap.

## Shared outcome contract

The publisher's resolved result means a confirmed publication. A remote
service accepting a record in a nonpublic state is a separate outcome.
`AcceptedPublicationError` carries its non-secret remote ID and safe URL.
The worker retains this receipt on the exact send claim as `unknown`, completes
the job, and tells the editor to inspect the destination. It must never retry
the create request or claim that the content is live.

Receipt writes use the existing bounded recording budget. A recording failure
leaves the durable in-flight claim available for reconciliation; it never
releases that claim for another send. A late result may enrich its own
unasserted unknown receipt, but cannot overwrite a newer human resolution,
another tenant's record, or a newer delivery attempt. Telegram multipart
evidence remains separate from this generic receipt.

Adapters distinguish a known provider rejection, a failure before sending,
and an uncertain result after sending. Timeouts, lost response bodies and
unrecognizable responses after a create request remain uncertain. A successful
response missing the required receipt is insufficient evidence to retry.

## Connection and destination identity

Credential replacement is an encrypted, whole-bag operation. The connection
retains the reviewed target identity across refresh or reconnection; changing
the target requires a new channel. Expiry, granted scopes, connection generation
and reauthorization state are non-secret lifecycle metadata. Verification
reports which permission was checked; reading an identity is not proof of a
publishing grant. Disconnect revokes or removes credentials without erasing
publication history. Existing queued jobs use the current credential generation
and must refuse a revoked or changed target.

OAuth state is one-use and bound to the organization, brand, acting user and
intended target. Token exchange runs on the server against fixed provider
endpoints. Registered HTTPS callback, provider application permissions and live
test accounts are external acceptance prerequisites; fixture tests cannot stand
in for those approvals. Prefer `oauth4webapi` for the protocol when implementing
OAuth rather than handwritten token validation.

## LinkedIn

Use the current versioned Posts API with explicit version and REST.li protocol
headers. Public text posts identify a person or organization author. Retain the
`x-restli-id` receipt returned with creation. Escape literal commentary for
LinkedIn's text grammar before serializing JSON. Personal publishing and page
publishing have different grants and page-role requirements. Do not infer
analytics or inbox access from a write grant.

Text support can land as a documented first increment. Image and video uploads
need reviewed media capabilities, provider upload-host validation and container
readiness before being enabled. Never silently drop attached media. Native
Instagram similarly needs an explicit mode distinct from existing manual
channels.

Official references: [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api?view=li-lms-2026-09),
[text grammar](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/little-text-format?view=li-lms-2026-03),
[authorization code flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow),
[refresh-token eligibility](https://learn.microsoft.com/en-us/linkedin/shared/authentication/programmatic-refresh-tokens).

## WordPress

The initial connection supports self-hosted WordPress over public HTTPS,
including installations under a subdirectory. Use the username and an
application password. A read-only connection test checks the authenticated
user's publishing capability. A scheduled Pubrick job creates the post when
it is due; it does not independently create a future schedule in WordPress.

Carry the reviewed title alongside the reviewed channel body. Escape plain
text with the maintained HTML helper already installed in the workspace.
Rich article and media support require their own reviewed output contract.
The adapter uses the existing guarded transport: public addresses, fixed
connected host, bounded responses and no authenticated redirects. Credentials
never appear in URLs, logs or API responses.

Only a returned `publish` state confirms publication. An accepted `draft`,
`pending` or `future` record retains its ID and safe same-origin URL through
the shared unknown-receipt path. Do not treat a slug or an arbitrary
idempotency header as protection against duplicate creation. WordPress.com
has a separate OAuth/API contract and is not implied by the self-hosted mode.

Official references: [REST authentication](https://developer.wordpress.org/rest-api/using-the-rest-api/authentication/),
[post states and fields](https://developer.wordpress.org/rest-api/reference/posts/),
[user capabilities](https://developer.wordpress.org/rest-api/reference/users/),
[WordPress.com OAuth](https://developer.wordpress.com/docs/api/oauth2/).

## Acceptance

Test exact request bodies and credential destinations, permission and expiry
states, safe transport refusals, accepted nonpublic receipts, recording failure,
late results, human resolution and duplicate job delivery. Cover credential
rotation and tenant isolation through the API. Built UI acceptance must show
connection state, target identity, supported media, confirmation and practical
recovery. Record live provider acceptance separately from local fixture
evidence and update the public capability inventory only after implementation.
