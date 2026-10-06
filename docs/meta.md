# Native Meta publishing

Pubrick has separate native destinations for Threads, Instagram professional
accounts and Facebook Pages. Existing **Instagram manual** channels stay manual;
connecting a native account never converts them or changes their history.

## Supported content

| Destination | Reviewed format | Initial limits |
| --- | --- | --- |
| Threads | Text | 1–500 characters |
| Instagram automatic | One JPEG, optional caption | At most 8 MB; width 320–1440 px; aspect ratio 4:5–1.91:1; sRGB; caption ≤2200 characters, ≤30 `#` and ≤20 `@` markers |
| Facebook Page | Text | 1–4096 characters (Pubrick's current saved-text limit) |

Video, carousels and article images are not supported by these native modes yet.
Pubrick refuses unsupported attachments before approval and again in the worker;
it never publishes a text substitute for an approved image. Uploaded images are
normalized before preview. An image outside Instagram's supported dimensions
must be replaced with a suitable image and reviewed again.

## Configure a server

Set a canonical public HTTPS `PUBLIC_ORIGIN` in the repository's `.env` for
Docker Compose. The API receives it as `BETTER_AUTH_URL` and `WEB_ORIGIN`;
the worker also receives `WEB_ORIGIN`. These origins must agree. A provider
must be able to reach the callback and Instagram image origin. Localhost
fixtures do not establish that external reachability.

Configure each provider independently, leaving both values blank to disable it:

| Provider | Confidential application environment | Fixed callback path |
| --- | --- | --- |
| Threads | `THREADS_CLIENT_ID`, `THREADS_CLIENT_SECRET` | `/en/connections/meta/threads` |
| Instagram Login | `INSTAGRAM_CLIENT_ID`, `INSTAGRAM_CLIENT_SECRET` | `/en/connections/meta/instagram_native` |
| Facebook Login | `FACEBOOK_CLIENT_ID`, `FACEBOOK_CLIENT_SECRET` | `/en/connections/meta/facebook_page` |

Set each configured pair on **both API and worker**, then restart them. These
are server application credentials, not workspace access tokens and never
browser `NEXT_PUBLIC_*` variables. A missing pair disables that provider;
a half-configured pair or incompatible origin refuses startup. Graph transport
is pinned to `META_GRAPH_API_VERSION=v26.0`; Threads uses its independent API.

The provider application needs its product, registered callback, approved
permissions and eligible real accounts. Pubrick's fixtures cannot grant app
review or production access. Required grants are:

- Threads: `threads_basic`, `threads_content_publish`.
- Instagram Login: `instagram_business_basic`, `instagram_business_content_publish`.
- Facebook Page: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`,
  plus the current Page `CREATE_CONTENT` task.

Instagram Login uses an eligible professional account without requiring a linked
Facebook Page. Facebook Page discovery is bounded; the user explicitly chooses
one verified eligible Page. Pubrick never connects the first Page automatically.

## Connect, renew and disconnect

Open a brand's Channels section, choose the native destination and select
**Connect account**. The provider screen supplies the actual grants and identity.
Pubrick validates the returned state against the current user, session,
workspace, brand, configured application and original channel intent.
Authorization and Page selection are single-use and expire after ten minutes.
No endpoint accepts pasted Meta tokens.

The channel shows its account, access expiry and connection state. Use
**Reconnect** to renew the same destination. A different account or Page needs
a new channel. **Disconnect** invalidates the current credential generation;
saved content, schedules and receipts remain. Pending work cannot publish with
disconnected, expired or mismatched application credentials.

Tokens are encrypted, never returned to the browser and never put in queue
payloads. Changing the server application requires reconnecting its channels.
Pubrick does not promise unattended token renewal: reconnect when access expires.

## Publication and recovery

Approve the actual saved text and image. Threads and Instagram first prepare
a nonpublic container, retain its identity, then wait through durable queue
checkpoints. Readiness does not create another attempt. The worker rechecks
the saved content, destination, credential generation, application and live job
authority before preparation and final publication.

Instagram receives an encrypted, purpose-bound image capability for the exact
approved JPEG. It expires within five minutes and the preparation deadline.
Every fetch checks tenant, stage, attempt, parents, current generation, reviewed
body and image hash. The private media library stays authenticated.

A container ID is **not** a published post ID. The content screen lists retained
preparation phases and their container IDs separately from publication receipts.
If a nonpublic preparation cannot be confirmed, an editor can inspect the exact
saved attempt and choose **Discard** in Meta preparation, acknowledging possible provider
quota use. Discarding preserves its evidence and only cancels that checkpoint;
it does not approve content, create a new attempt or send a request. Review and
approve the saved content separately to try again. Active jobs, live leases,
newer attempts and final publication evidence refuse this action.

An uncertain final request uses the
existing unknown-outcome recovery: inspect the provider before deciding whether
to retry. Confirmed late receipts retain their original claim and cannot
overwrite a newer human resolution. Publishing a container never retries
automatically after an uncertain answer.

## Protocol references and acceptance

Provider research and exact official references are recorded in
[the Meta lifecycle specification](specs/0026-meta-publication-lifecycle.md),
including Instagram Login, Threads token inspection and Page task checks.
The OAuth flow reuses `oauth4webapi`; publication reuses Pubrick's bounded
guarded transport rather than the advertising SDK's token-bearing query strings
and crash reporter.

Local acceptance uses synthetic provider transport, real PostgreSQL authority
and scoped HTTP requests. A live application, approved eligible accounts,
reachable HTTPS callback/media origin and actual provider receipts remain
separate external acceptance prerequisites. No fixture success is advertised
as real provider publication.
