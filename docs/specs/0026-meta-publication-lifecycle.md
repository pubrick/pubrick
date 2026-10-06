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

The [current Threads token-inspection guide](https://developers.facebook.com/documentation/threads/troubleshooting/debug-access-token)
(updated August 18, 2026) requires an app token or a Threads tester's token for
`debug_token`; an ordinary connected user's token is not sufficient. Use the
server-owned `TH|<APP_ID>|<APP_SECRET>` app token to inspect the separately saved
user token. The app can inspect only its own tokens. Require actual `type: USER`,
`is_valid: true`, identity, scopes and expiry; no undocumented `app_id` response
field or tester-only self-inspection is a production publishing proof.

The developer site was unavailable to the research tool, but its current pages
were subsequently read in the browser on 2026-10-06. The [Instagram publishing
guide](https://developers.facebook.com/documentation/instagram-platform/content-publishing)
confirms the native `graph.instagram.com` host, bearer authorization, separate
container and publish requests, and status reads. For this initial image flow,
follow its one-minute polling interval and five-minute bounded processing check.
Its quota prose differs between sections; query the documented publishing-limit
endpoint and respect provider refusal rather than invent a universal quota.

The [image reference](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/media)
specifies JPEG, at most 8 MB, an aspect ratio from 4:5 through 1.91:1, width
320–1440 pixels and sRGB. Normalize before human preview; the approved bytes
must be the bytes served to the provider. Captions allow at most 2,200 characters,
30 hashtags and 20 mentions. Video is a separate validation contract.

The [native login flow](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/business-login)
returns actual granted permissions at code exchange. A long-lived token's expiry
comes from the provider's exchange response, bound to that encrypted token.
Do not invent an Instagram-native `debug_token` endpoint or reuse Facebook's
inspector. The [native identity guide](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/get-started)
distinguishes the app-scoped `id` from professional-account `user_id`; request
both and bind the OAuth subject and publication destination explicitly.
The [publishing-limit reference](https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit)
requires both native publishing permissions. A successful scoped read provides a
current publishing-capability probe; it is not scope enumeration or token-expiry
introspection. Rejected or inconclusive reads must not be called a valid grant.

The [Facebook Page feed reference](https://developers.facebook.com/docs/graph-api/reference/page/feed/)
requires a Page token, the `CREATE_CONTENT` task and `pages_manage_posts`,
`pages_read_engagement`, `pages_show_list` for text publication. Its publishing
contract is narrower than the multi-operation Pages guide. Graph examples use
`v26.0`; do not apply that version to Threads. Provider app configuration and
live receipts remain external acceptance checks.

The [Page discovery guide](https://developers.facebook.com/documentation/pages-api/getting-started)
and [User accounts reference](https://developers.facebook.com/docs/graph-api/reference/user/accounts)
provide the fresh task proof: use the retained User token to read `/me/accounts`
with `id,tasks`, and require the exact selected Page's `CREATE_CONTENT` task.
Store that User token encrypted beside the separately selected Page token.
Bound pagination, reject ambiguous or truncated discovery, and reconstruct
cursor requests on the fixed official host/path rather than following a
token-bearing `paging.next` URL. Token inspection uses server-owned app
credentials. Neither a Page identity read nor saved task/scope strings proves
the current publishing grant.

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
Page text. Enforce the primary-reference dimensions and Page grants above
before registering their adapters.
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

An inconclusive initial read before any staged attempt is admitted ends as a
visible known-not-sent failure, with explicit user retry. It must not exhaust
the ordinary queue while leaving the adaptation queued without a checkpoint.
Admission and this terminal write bind the exact saved decision, text, target,
credential generation and encrypted bag to the current active pg-boss job
incarnation (ID, queue, retry count, start and expiry). Read DB wall time after
lock waits; a cancelled job or newer human decision always wins over a late
read-only provider response.
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
