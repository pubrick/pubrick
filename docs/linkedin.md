# LinkedIn personal publishing

Pubrick connects a personal LinkedIn account through OAuth and publishes public
text posts with the official Posts API. Company pages, media uploads, analytics,
inbox access and automatic token refresh are not supported by this connection.

## Operator setup

1. Create a LinkedIn developer application and obtain access to **Share on
   LinkedIn** (`w_member_social`) and **Sign In with LinkedIn using OpenID
   Connect** (`openid profile`). Provider approval and account availability are
   external requirements; installing Pubrick does not grant them.
2. Serve Pubrick at a canonical public HTTPS `PUBLIC_ORIGIN`. The API's
   `BETTER_AUTH_URL` and `WEB_ORIGIN` must identify that same root origin.
3. Register exactly `https://your-domain/en/connections/linkedin` as an authorized
   redirect URL in the LinkedIn application. All four UI languages use this fixed
   callback, then return to the language saved when authorization started.
4. Set `LINKEDIN_CLIENT_ID` and `LINKEDIN_CLIENT_SECRET` together in the server's
   `.env`, and restart both API and worker. Compose passes both values to these
   services. Do not use `NEXT_PUBLIC_*` variables or put application secrets in
   the browser. Leaving both unset keeps LinkedIn disabled and other channels
   available.

## Connect, reconnect and disconnect

An organization owner or admin opens a brand's channel form, chooses LinkedIn,
names the channel and selects **Connect**. LinkedIn returns to Pubrick, which
validates OAuth state, OIDC nonce and identity, then checks the application's
actual personal publishing grant through LinkedIn token introspection. Reading an
identity alone does not prove publishing permission.

The channel shows the account, expiration and connection state. **Reconnect**
renews authorization for the same personal account. Connecting a different account
requires a new channel; a reconnect cannot change the destination of existing
scheduled content. Concurrent reconnects and disconnects use a saved credential
generation, so an older callback cannot overwrite a newer connection.

**Disconnect** removes the locally encrypted credentials. Scheduled jobs,
adaptations and publication receipts remain. A post already being sent may finish;
disconnecting cannot revoke an HTTP request that has already left the worker.
Disconnect does not revoke LinkedIn's application authorization. The account owner
can also revoke access in their LinkedIn account settings.

Tokens and any provider-issued refresh token are encrypted as one credential bag.
Pubrick exposes only bounded account, scope, expiration and lifecycle metadata.
There is no silent refresh: expired or revoked access requires **Reconnect**.
A rejected grant is shown as requiring reconnection; an inconclusive provider
check is not evidence that an otherwise current token was revoked.

## Delivery and recovery

Each send rechecks the application grant and personal identity before the create
request. Immediately before creating the post, the worker checks that the channel
still has the same credentials, destination and live send claim. The three
provider requests have individual 30-second full-response deadlines, within a
90-second provider budget. Callback exchange, identity and grant verification
have a 120-second provider budget. No database transaction stays open while
waiting for LinkedIn.

A confirmed `201` receipt with a valid `x-restli-id` identifies the published post.
An accepted but unconfirmed state retains that receipt for manual resolution.
A timeout after create, a lost receipt or an ambiguous server failure is an
unknown outcome: Pubrick does not automatically create the post again.

Authorization requests expire after ten minutes and are consumed before code
exchange. An interrupted exchange requires a fresh request. Pubrick rechecks the
current session, organization and manager membership after the provider replies,
before retaining credentials. Failed callbacks offer a route back to brands,
without retrying a one-use code.

## Protocol choices and acceptance limits

OAuth uses maintained [`oauth4webapi`](https://github.com/panva/oauth4webapi)
3.8.8. The confidential server web flow uses random state, OIDC nonce and the
application secret. LinkedIn documents PKCE separately for enabled native apps
with a loopback redirect; Pubrick does not add undocumented PKCE parameters to
the web flow. ID token claims and nonce are validated by the library and userinfo
must match the validated subject. The token comes directly from the fixed HTTPS
token endpoint; Pubrick does not claim a separate local JWT signature check.

Automated coverage uses local fixtures and real database transactions. A live
approved application and account must confirm provider nonce echo, scope
availability and a real publication receipt before an operator advertises this
connection as validated for their installation. A missing nonce fails closed.

Official references:

- [Server authorization code flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow)
- [Native PKCE flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow-native)
- [OpenID Connect identity](https://learn.microsoft.com/en-us/linkedin/consumer/integrations/self-serve/sign-in-with-linkedin-v2)
- [Token introspection](https://learn.microsoft.com/en-us/linkedin/shared/authentication/token-introspection)
- [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api)
- [OIDC ID token validation](https://openid.net/specs/openid-connect-core-1_0.html#IDTokenValidation)
