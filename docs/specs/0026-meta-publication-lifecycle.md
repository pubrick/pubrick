# Meta connections and asynchronous publication

Date: 2026-10-06. Proposed continuation of competitive-parity milestone 3,
tracked in Beads `Ozon-tools-zib2q.11`. This design is not an availability claim.
Independent review precedes implementation.

## Provider contracts

Keep existing `instagram` channels manual. Add a distinct native Instagram
platform for professional accounts using Instagram Login. This mode does not
require a linked Facebook Page; it uses the current
`instagram_business_basic` and `instagram_business_content_publish` scopes.
Facebook Page publishing is a separate destination, identity and permission
contract. Threads uses its own application credentials and publishing scopes;
do not reuse a Facebook app secret or infer read/reply access from write access.

Use the maintained `oauth4webapi` protocol client where the documented provider
flow is compatible. Reuse the established tenant/user/session-bound one-use
authorization and immutable destination rules. Keep provider-specific token
exchange, grant inspection, expiry and refresh behavior explicit. A reconnect
to another account requires a new channel. Fixed provider hosts, bounded
responses, no authenticated redirects and redacted failures remain mandatory.
Choose supported Graph versions from verified provider references and expose
configuration deliberately; do not guess a latest version from a blog.

The [official Business SDK transport](https://github.com/facebook/facebook-nodejs-business-sdk/blob/main/src/api.js)
currently pins Graph `v26.0`. Its default transport puts the token in query
strings and enables crash reporting. Prefer Pubrick's existing bounded guarded
transport for publication rather than adding the full advertising SDK; this
choice preserves explicit receipt and secret-handling behavior. It does not
establish the same version requirement for Threads' separate API.

Official references inspected: [Meta's Instagram Login collection](https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login),
[Meta's Threads authorization collection](https://www.postman.com/meta/threads/folder/34203612-e0373e84-de6b-46f1-b90d-3fea76ba6782),
[Meta's Threads sample](https://github.com/fbsamples/threads_api),
[Meta's container status collection](https://raw.githubusercontent.com/fbsamples/threads_api/main/postman/threads-api.postman_collection.json).
The [current official Threads sample](https://raw.githubusercontent.com/fbsamples/threads_api/main/src/index.js)
uses `graph.threads.com` and `www.threads.com`. Pin these direct hosts; do not
follow authenticated redirects from older `.net` examples. Its
[official collection source](https://raw.githubusercontent.com/fbsamples/threads_api/main/postman/threads-api.postman_collection.json)
defines GET container status with `id,status,error_message`. Follow that
request contract rather than the collection's contradictory publish-POST prose.
Use these sources as protocol references; do not copy their sample code.

The developer-site pages were unavailable to the research tool; its changelog
and live application configuration remain explicit acceptance checks.

## Approved media access

The private media API must stay private. A provider that pulls an attachment
needs an expiring capability for that exact approved asset, not an anonymous
media library. Bind the capability to the organization, adaptation, delivery
attempt, media ID, immutable bytes/MIME and purpose. Serve only that bounded
JPEG or MP4, refuse expiry or changed bytes, and exclude tokens from logs.
The configured public HTTPS origin must be reachable by the provider. Local
fixtures use an owned loopback origin; a localhost media URL is not live
provider acceptance.

Capability previews and approval must agree with the adapter. Unsupported
formats refuse before sending; attachments are never silently dropped. Initial
formats are Threads text, native Instagram one normalized JPEG and Facebook
Page text. Document Instagram's exact dimensions/size and Facebook's required
Page grants/tasks from accessible primary references before shipping adapters.
Existing MP4 checks establish container shape and size, not codec or duration;
video needs a maintained metadata validation contract before native support.
Carousel and specialized formats require their own reviewed contract.

Add immutable asset identity and SHA-256 bytes digest to the staged input.
Capability expiry cannot exceed the preparation deadline or 24 hours. Permit
provider GET/HEAD fetch retries for the same approved bytes until expiry, without
turning the capability into a one-use download or extending it on retry.

## Durable container stages

Preparing a nonpublic container and publishing it are different side effects.
Disable any provider option that publishes automatically during preparation.
Persist preparation intent before that side effect; then persist the accepted
container ID, exact delivery/input identity, credential generation and deadline
before another request. A lost preparation answer with automatic publication
disabled proves no public post, but repeated preparations still consume quota.
Require explicit preparation recovery rather than automatically creating a new
container when the previous ID was lost. Container preparation alone is never
a confirmed publication.

Readiness polling uses a durable checkpoint and bounded delayed queue jobs,
not a process held open for the provider's entire processing period. Every
resume belongs to the same publication attempt. Ordinary `markPublishing`,
retry-chain admission and unresolved-send claims cannot serve as readiness
resumes: they currently increment attempts or classify old in-flight requests
as uncertain sends. Add a separate stage/resume contract and make recovery
sweeps and dead-letter handling distinguish preparation from final intent.
A lease with a fencing token
protects the checkpoint; an expired worker cannot send after another worker
takes over. Recheck the delivery, reviewed inputs, destination, credential
generation and permissions immediately before the final publication request.

Write a durable final-request intent before issuing that request. A crash or
uncertain answer after this point follows existing unknown-outcome handling;
it must not restart container creation or automatically repeat publication.
A confirmed result enriches its own receipt, respecting newer human decisions.
Read-only polling may resume after a crash in the waiting stage. An expired or
explicitly rejected unpublished container has a different recovery from an
uncertain final request. A readiness result of `PUBLISHED` prevents another
publish request, but a container ID still must not become a confirmed post ID
or permalink. Retain the preparation checkpoint and recover the actual post
reference through documented read-only behavior or explicit human inspection.
Cancellation fences the final request and does not
pretend to delete a remote post.

## Reader experience and acceptance

Meta login is not LinkedIn OIDC. Preserve server-owned one-use state and strict
duplicate-parameter checks, then prove the provider's actual token grants and
account identity. Facebook requires verified Page discovery, explicit Page
selection and separately encrypted Page tokens. Token exchange/extension,
expiry and refresh behavior follow each provider's documented contract.

Show connection identity, permission/expiry state, processing progress and
the next available recovery action. Distinguish a container ID, confirmed post
and unknown final result. Do not offer an inspection link that implies a
nonpublic container is a live post. Existing manual channels and receipts stay
available throughout migration.

Fixture acceptance covers exact requests, forbidden automatic publication,
asset scope/expiry, readiness, cancellation, stale leases, token rotation,
final-intent crashes, late receipts and duplicate jobs. Built desktop/mobile
journeys verify supported media and recovery. Record real account/application
approval, configured HTTPS callback/media origin and provider receipts
separately. Payments remain deferred.
