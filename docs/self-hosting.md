# Self-hosting Pubrick

## Requirements

- Docker with Compose v2
- 1 GB RAM minimum for the skeleton; Postgres data lives in the `pgdata` volume

## Install

```bash
git clone https://github.com/pubrick/pubrick && cd pubrick
cp .env.example .env

# Generate two separate secrets and paste each into .env, replacing the
# placeholder values of BETTER_AUTH_SECRET and APP_ENCRYPTION_KEY — leaving
# them as shipped does not stop at this command; see below.
openssl rand -base64 32
openssl rand -base64 32

# Set POSTGRES_PASSWORD and PUBLIC_ORIGIN in .env as well, then start:
docker compose up -d
```

Three variables are required and have no defaults; `docker compose up` stops
immediately with `required variable X is missing a value: …` if any is unset —
but that check only looks at whether the variable has *a* value, not whether
it is still the placeholder text `.env.example` ships. A `.env` copied and
never edited passes it, because every variable in the block below is set to
*something*.

- `BETTER_AUTH_SECRET` signs session cookies.
- `APP_ENCRYPTION_KEY` encrypts channel and AI credentials at rest, so back it
  up: losing it makes every stored credential unreadable. It is a comma-separated
  ring of one or more keys, newest first, and each must base64-decode to exactly
  32 bytes — the api refuses to boot otherwise. See
  [Rotating `APP_ENCRYPTION_KEY`](#rotating-app_encryption_key).
- `PUBLIC_ORIGIN` is the origin a browser types, scheme included
  (`https://your-domain.example`). Auth cookies, redirects and the trusted-origin
  list all come from it, and one left on `http://` behind TLS serves session
  cookies without the `Secure` attribute.

**Change `WEB_PORT` and `PUBLIC_ORIGIN` has to follow.** Nothing derives one
from the other. `WEB_PORT=3080` with `PUBLIC_ORIGIN` left at
`http://localhost:3000` is the single most common first-run failure: the site
loads at `http://localhost:3080`, and every sign-in is refused, because the
session cookie would be issued for an origin the browser is not on. Typing
`127.0.0.1` where the variable says `localhost` does the same thing — to a
browser those are two different origins, and a cookie set for one is never sent
to the other — and so does putting a reverse proxy in front on a name
`PUBLIC_ORIGIN` has never heard of.

Pubrick now says which two values disagree rather than leaving you to guess:

- the login screen's refusal names **both** — the origin you opened and the one
  `PUBLIC_ORIGIN` is set to — in your own language, and says which to change;
- `docker compose logs api` prints the origin this instance accepts at every
  boot, next to the port it came up on, so the answer is available before
  anybody tries to log in.

Behind a reverse proxy this check costs nothing and refuses nothing: it compares
the browser's `Origin` header, which every hop passes through untouched, never
`Host` or `X-Forwarded-Host` (both of which name the proxy's next hop, not the
address anybody typed). A request that carries no `Origin` at all — `curl`, a
script, the MCP server — cannot be checked and is passed straight through to
better-auth's own origin check, unchanged.

**Leaving either secret as the shipped placeholder does not fail the way the
paragraph above does.** `docker compose up` accepts it — the value is set, just
not to anything real — and only the api itself refuses it, at its own boot:
either because the placeholder fails the 32-byte format check above, or
because it exactly matches a value published in this repository (the old
`init.sh` fallbacks and the `.env.example` placeholders — see
[`auth-policy.ts`](../apps/api/src/auth-policy.ts)), which the api treats the
same as a leaked key regardless of format. Either way the refusal happens
*inside the api container*, as a crash on startup, which `restart:
unless-stopped` then repeats forever. The web container will not come up
behind it: it now waits for the api's own healthcheck before starting, so a
placeholder left in place makes `docker compose up -d` report the failure
(and no service on port 3000 at all) rather than quietly serving a website
whose every backend call fails. Run `docker compose logs api` — the first
lines name exactly which variable is still a placeholder and how to fix it.

Every one of the three services publishes a port to the host by default —
`WEB_PORT` (default `3000`, meant to be reached from outside the host; put
your TLS terminator here), `API_HOST_PORT` (default `3001`, bound to
`127.0.0.1` only — the web app proxies `/api` to it over the compose network,
this mapping exists only so you can `curl` the health endpoint or debug from
the host) and `POSTGRES_PORT` (default `5432`, also bound to `127.0.0.1` —
neither the api nor the worker use it, they reach Postgres over the compose
network regardless of what this resolves to). Set any of the three in `.env`
if the default is already taken on your host — 5432 in particular is the
single most common port a developer's machine already has something on. See
the "Ports" section of [`.env.example`](../.env.example) for the exact
variable names.

If you instead override a port with a `docker-compose.override.yml`, know
that Compose **merges** a service's `ports` list by appending rather than
replacing: an override file that adds its own `ports:` entry for a service
this file already publishes a port for ends up trying to bind both, and the
container fails to start. Use the `.env` variables above instead — they
change the one port entry already in this file rather than adding a second
one.

Database migrations run automatically when the api container starts.
On an existing installation, the recent AI spend history index is prepared
concurrently before transactional migrations. A large usage ledger can make
startup take longer, but metering writes can continue while PostgreSQL builds
the index. An interrupted build is retried at the next startup.

## Connect Gemini

Create a Gemini API key on the [Google AI Studio API keys page](https://aistudio.google.com/apikey).
AI Studio calls it an API key; there is no separate AI Studio credential for
Pubrick. In **Settings → AI provider**, choose **Google**, paste the key into
**API key**, save it, and use **Test**. The key belongs in Pubrick's organization
settings, not in `.env`. Only workspace owners and admins can manage it.

Google now creates **authorization keys** by default. Check the **Key Type**
column in AI Studio and use an active **Auth** key; older **Standard** keys may
be rejected, especially when unrestricted. The environment variable name
(`GOOGLE_API_KEY`, `GEMINI_API_KEY`, or another name) does not identify the key
type. Paste only the key value, without `NAME=`. See Google's
[key migration guide](https://ai.google.dev/gemini-api/docs/api-key#migrate-to-an-auth-key).

The default text model is `gemini-3.8-flash`. A previously saved custom
**Default model** in **Advanced** remains in effect until you change or clear
it. Google lists 3.8 Flash as a stable model with structured output and
`low`/`medium`/`high` thinking levels; it does not generate images. The
[Gemini API pricing page](https://ai.google.dev/gemini-api/docs/pricing)
shows the current token rates and free/paid tiers. Paid tier access requires
billing on the Google project that owns the key.

If the Google endpoint is unavailable from your server, open **Settings → AI
provider → Advanced** and save an HTTP(S) forward proxy URL with an explicit
port under **Google proxy URL**. This setting applies to the current workspace's
Google calls in both API and worker. Pubrick encrypts it with the same key ring
as the API key and never returns the saved URL to the browser. Use **Remove**
there to clear it. The instance operator must first approve the proxy's
`host:port` in `GOOGLE_PROXY_ALLOWED_HOSTS` in `.env`; the host and port of an
existing `GOOGLE_API_PROXY` are approved automatically. This server-side gate
prevents workspace admins from directing server requests to arbitrary internal
addresses. An instance operator may also set `GOOGLE_API_PROXY` in `.env` as a
fallback for workspaces without their own proxy. Changes to either environment
variable require recreating both `api` and `worker` containers. Keep the proxy
URL and Gemini key private.

## Rotating `APP_ENCRYPTION_KEY`

`APP_ENCRYPTION_KEY` is a **ring**: one or more base64 keys separated by commas,
the active one first. A single key is a ring of one and is what almost every
install runs.

To rotate, put the new key in front of the old one and restart both the api and
the worker:

```env
APP_ENCRYPTION_KEY=<new key>,<old key>
```

From that moment every credential is written under the new key, and every
credential written before it is still read with the old one. There is no
migration to run before the new key works and no window where the product cannot
read its own data — which is the point of doing it this way rather than
re-encrypting everything on deploy.

Stored credentials move onto the new key as they are used: pressing **Test
connection** on a channel re-encrypts it, and saving credentials through
**Edit** writes them under the new key outright. Keep the old key in the ring
until nothing is left on it; there is no harm in leaving it there, and removing
it early makes whatever is still on it unreadable.

Telegram source sessions are different: polling reads them but does not re-encrypt
them. If you connected a workspace before rotation, reconnect it from **Settings
→ Telegram source account** or use the terminal command in
[Telegram channel sources](telegram-sources.md) before removing the old key. The
source row reports a connection error if its session cannot be opened.

Nothing moves while the ring has one key. Rows written before the ring existed
carry no version and no key id; under a single key **Test connection** leaves
them exactly as they are, because there is no other key to move them off — and
because a worker still on the previous release reads only that shape (see
[Upgrade](#upgrade)). Rows change format only once a second key is in the ring,
and from then on they move as described above. A credential saved or edited
after the upgrade is written in the new format under any ring; a worker on the
previous release cannot read it, which is why the worker goes first.

Each key is validated at boot, so a typo in the second one is a refusal to start
rather than a credential that silently cannot be read months later. Every key in
the ring is also checked against the values published in this repository — a
rotation cannot smuggle the example key into second place.

If a credential does become unreadable — the key was dropped, or a row was
tampered with — the product notices it in four places, and says two different
amounts about it. A channel's connection test and a failed post both name the
cause: the stored credentials were encrypted with a key this instance no longer
has. The **AI key's Test button and a failed generation say only that the stored
key could not be read**, and leave you to connect that to a key rotation — so if
an AI key that worked yesterday now reports that, check `APP_ENCRYPTION_KEY`
before you go looking for a revoked key at the provider. Either way the fix is
the same: restore the old key to the ring, or save the credentials again.

## Who can register

Pubrick is meant to sit on a public URL, so registration is not open by default.
`SIGNUP_MODE` in `.env` decides:

| `SIGNUP_MODE` | Who may create an account |
| --- | --- |
| unset (default) | anyone, until the first account exists — then invite-only |
| `open` | anyone with the URL |
| `invite` | only an address an existing member has invited |
| `closed` | nobody |

The default is deliberately self-closing: a fresh install has to let *someone*
create the first account with no configuration, and the moment that account
exists the door shuts on its own. Nobody has to remember to flip a setting back,
which is how instances that were opened "just for a minute" stay open. The window
is one account wide, so create yours right after `docker compose up` — before you
point DNS or a TLS terminator at the box.

Under `invite` and `closed`, every refused sign-up gets the same reply whether or
not the address is already registered, so the endpoint cannot be used to test
which of your colleagues has an account.

**Adding people.** Open **Settings** and find the **Workspace** card: it lists
everyone in the organization, and **Invite** asks for an address. An account
with the ordinary **Member** role can invite another member. Owners and admins
may also invite people as authors or editors, or grant elevated roles. Author
and editor roles cannot invite. The API rejects attempts by ordinary members to
assign any other role, including through a direct request outside Settings.

Pubrick has no mailer, so it does not send the invitation for you. What you get
back is a link to this instance, which you pass to the person yourself. It is
shown once, in the dialog that created it; inviting the same address again
replaces the invitation and mints a new link, which is how you re-issue one
somebody lost — and which stops the old link working.

The invitee opens the link, creates an account **with exactly the address you
invited**, and lands on a screen offering the organization by name; one click
joins it. Every member sees the pending invitations on the same Workspace card
but only owners, admins, and ordinary members can **Remove** one. Authors and
editors can read the invitation list without changing it. Changing a person's
role clears their explicit brand assignments; an owner or admin can assign
brands again from each brand's **Team access** page.

**What the link is, and is not.** It is not a password. Anyone who obtains it
learns only that this instance exists: joining still requires a session whose
address matches the invitation, and registering still requires an address the
signup gate has an invitation for. An invitation is single-use — accepting it
spends it — and expires 48 hours after it is created; a spent, revoked or stale
one is refused with the same generic answer a stranger gets, so it cannot be
used to confirm that an address was ever invited.

**What the address is.** The address *is* the credential, and Pubrick does not
verify email — there is no mailer to verify it with. So whoever knows an
invited address can register it before its owner does. Invite an address only
the recipient controls, and if an invitation goes astray, remove it on the
Workspace card rather than leaving it to expire.

## Auth rate limiting and client IPs

Sign-in, sign-up, change-password and change-email are capped at 3 requests per
10 seconds per client; everything else under `/api/auth` at 100 per 10 seconds.
This is on by default and does not depend on `NODE_ENV`. `AUTH_RATE_LIMIT_ENABLED=false`
turns it off — only sensible if something in front of Pubrick already limits
`/api/auth`.

"Per client" needs a client address, and the api can only get one from a
forwarded header. The web app's `/api` proxy passes a caller's own
`X-Forwarded-For` through untouched, so Pubrick believes that header **only**
when you declare who is allowed to set it:

```dotenv
TRUSTED_PROXIES=127.0.0.1        # nginx/Caddy on the same host
TRUSTED_PROXIES=10.0.0.0/24      # a load balancer subnet
```

List the proxies between the internet and Pubrick, most specific first — the
address or subnet they connect from, never a broad private range that also covers
your users. With `TRUSTED_PROXIES` set, the forwarded chain is walked from the
right past your proxies and the first address beyond them is the client.

While it is empty, rate limiting still applies but shares one bucket per endpoint
across every caller, and sessions record no IP address. That is the safe way
round: an unset value costs you per-client granularity, whereas trusting the
header unconditionally would let a single attacker change it on every request and
never be limited at all.

## Connect a Telegram channel

1. Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, and
   follow the prompts. BotFather gives you a bot token — a string like
   `123456789:AAH...`.
2. Add the bot to the Telegram channel you want to publish to, then promote it
   to admin with the **Post Messages** permission (Channel settings →
   Administrators → Add Admin).
3. Get the channel's chat id. The simplest way: forward any message from the
   channel to [@userinfobot](https://t.me/userinfobot) — for public channels
   you can also use `@channelusername` directly as the chat id.
4. In Pubrick, open a brand → add a channel → platform **telegram** — paste
   the bot token and the chat id.
5. Press **Test connection**. It calls Telegram's `getMe`/`getChat`/
   `getChatMember` to confirm the token is valid and the bot can post to that
   chat, without sending any message. A failure here (bad token, bot not an
   admin) is reported inline — fix it before approving content for that
   channel, since the same failure will otherwise surface later as a `failed`
   adaptation once the worker attempts the real publish.

## Connect a VK community

1. Create a **user access token** with the `wall` permission for a VK account
   that administers the community. Keep the token private. VK's published
   [API schema for `wall.post`](https://github.com/VKCOM/vk-api-schema/blob/master/wall/methods.json)
   declares user authorization for this method.
2. Find the community's **positive numeric ID** (without the minus sign used
   in wall URLs). In Pubrick, open a brand → add a channel → platform **VK**,
   then enter the token and this ID.
3. Press **Test connection**. Pubrick checks the user, the token's `wall`
   permission, and community administration without publishing a test post.

VK publishing sends text posts and one reviewed JPEG cover. A cover also needs
the token's `photos` permission. The result links to the new community
wall post. A failed or uncertain send is classified by the same delivery rules
as Telegram; an uncertain outcome requires a human to inspect the wall before
another attempt.

## Connect a MAX chat or channel

1. Create a MAX bot and copy its token from the bot's settings. Find the numeric
   chat or channel ID and make the bot an admin with the **write** permission.
2. In Pubrick, open a brand → add a channel → platform **MAX**, then enter the
   bot token and chat ID. Press **Test connection** to check the bot, destination,
   and posting permission without sending a message.

MAX publishing sends text posts and one reviewed JPEG cover. Pubrick uses the current
[`platform-api2.max.ru` API](https://dev.max.ru/docs-api/methods/POST/messages)
and puts the token in the `Authorization` header, as MAX requires. If MAX returns
a public post URL, Pubrick keeps it with the publication.

## Connect a Bluesky account

1. Create an app password in your Bluesky account settings. Use the account's
   handle and this app password, not the account password. The current
   connector supports accounts hosted on `bsky.social`.
2. In Pubrick, open a brand → add a channel → platform **Bluesky**. Enter the
   handle and app password, then press **Test connection**. This authenticates
   without publishing a post.

Bluesky delivery supports text within its 300-grapheme limit and one JPEG cover.
The worker records the post URI and public URL when Bluesky returns them. An
uncertain create-record response is not retried automatically; inspect the
account before trying again. See Bluesky's
[post and image guide](https://docs.bsky.app/docs/tutorials/creating-a-post).

## Connect a Mastodon account

1. Create an access token with `write:statuses` permission in your Mastodon
   account settings. Copy the public HTTPS origin of your server, such as
   `https://mastodon.social`, without a path or port.
2. In Pubrick, open a brand → add a channel → platform **Mastodon**. Enter the
   server origin and token, then press **Test connection**. This verifies the
   account without posting.

Mastodon delivery currently sends text only and defaults to public visibility.
It checks the server's own status length limit before posting. A cover is
refused before any provider call. A confirmed status records its ID and public
URL when available; an uncertain send requires a human to inspect the account
before another attempt. See Mastodon's
[statuses API](https://docs.joinmastodon.org/methods/statuses/) and
[instance configuration](https://docs.joinmastodon.org/methods/instance/).

## Upgrade

```bash
git pull
docker compose up -d --build
```

Migrations apply on boot; back up the `pgdata` and `media` volumes before major
upgrades. Keep them together: post cover references live in Postgres and image
bytes live in `media` (see [Media library](media-library.md)).

### Enable role-template activation after the worker upgrade

The role-template editor can save and preview drafts immediately after the
upgrade. Activating a revision is held behind a database gate so an older worker
cannot start a generation run with instructions that it cannot pin. For a
single-host Compose install, finish `docker compose up -d --build`, confirm the
old worker container has stopped and the new worker is running, then enable the
gate once in PostgreSQL:

```sql
UPDATE role_template_activation_gate
SET release_epoch = release_epoch + 1, activation_enabled = true,
    updated_at = now()
WHERE id = 1 AND activation_enabled = false;
```

On a multi-host installation, first drain every older worker and confirm the
new worker build supports complete role snapshots before running that statement.
Already-started generation runs retain their built-in instruction baseline;
newly claimed runs use the active template revisions. If an old worker is still
handling generation jobs, leave the gate closed. See
[Versioned role templates](specs/0003-versioned-role-templates.md) for the
snapshot and activation contract.

The topic format upgrade (migration 0081) adds three `NOT VALID` checks for
topic formats and editorial SEO keywords. They reject invalid new writes as
soon as the upgrade commits. Existing rows receive safe defaults, so the
startup migration does not scan every topic or calendar slot under its schema
lock. To mark the checks validated later, run these statements individually in
a database session during a quieter period, outside Pubrick's startup
migration transaction:

```sql
ALTER TABLE calendar_slots VALIDATE CONSTRAINT calendar_slots_seo_keywords_check;
ALTER TABLE topics VALIDATE CONSTRAINT topics_content_type_check;
ALTER TABLE topics VALIDATE CONSTRAINT topics_seo_keywords_check;
```

Topic blocking (migration 0083) also adds `topics_block_state_check` as
`NOT VALID`. New writes are checked immediately, while existing rows avoid a
full table scan under the startup migration lock. Validate it separately
during a quieter period:

```sql
ALTER TABLE topics VALIDATE CONSTRAINT topics_block_state_check;
```

### Variables added since August 2026

`docker compose up` refuses to start when a **required** variable is missing,
naming it — but an optional one added after your `.env` was written simply takes
its default, silently. If your `.env` predates 2026-08-24, it is missing every
variable below. Diff it against [.env.example](../.env.example), which documents
each one in full.

| Added | Variable | Required? | What it decides |
| --- | --- | --- | --- |
| 2026-08-24 | `BETTER_AUTH_SECRET` | **yes** | signs session cookies |
| 2026-08-24 | `APP_ENCRYPTION_KEY` | **yes** | encrypts stored credentials; now a comma-separated key ring, newest first ([rotating](#rotating-app_encryption_key)) |
| 2026-08-24 | `PUBLIC_ORIGIN` | **yes** | the origin browsers type; auth cookies and the trusted-origin list come from it |
| 2026-09-02 | `SIGNUP_MODE` | no | who may register; unset means open until the first account exists, then invite-only ([who can register](#who-can-register)) |
| 2026-09-02 | `TRUSTED_PROXIES` | no | whose `X-Forwarded-For` is believed; empty means none, and rate limiting shares one bucket ([client IPs](#auth-rate-limiting-and-client-ips)) |
| 2026-09-02 | `AUTH_RATE_LIMIT_ENABLED` | no | defaults to on; only turn it off if something in front already limits `/api/auth` |
| 2026-09-04 | `WEB_PORT` | no | host port for the web app (default `3000`) — **set it and `PUBLIC_ORIGIN` must match** |
| 2026-09-04 | `API_HOST_PORT` | no | localhost-only debug mapping for the api (default `3001`) |
| 2026-09-04 | `POSTGRES_PORT` | no | localhost-only mapping for Postgres (default `5432`) |
| 2026-09-23 | `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | no | required together when reading Telegram channel sources ([setup](telegram-sources.md)) |
| 2026-09-11 | `PUBLISH_MAX_LATENESS_HOURS` | no | how many hours past its slot a scheduled post may still go out (default `6`); beyond it the delivery is recorded failed having sent nothing, and **Publish now** re-sends it. Setting it low fails posts the queue merely retried, so there is a floor — about **2 h**, derived from the queue's whole retry chain plus the abandoned-attempt sweep — and **the worker refuses to start** below it, naming the exact number. No off switch: `0` is refused, and "effectively never" is `8760` |
| 2026-09-25 | `PAID_REPLY_DISPATCH_AFTER` | no | optional ISO instant with a timezone offset; only automatic reply-analysis handoffs collected at or after this instant may start a paid Gemini call. Unset means no automatic paid dispatch. Existing manual Analyze remains available. Brand-level paid switches and daily admission thresholds must also be configured. |
| 2026-09-25 | `GOOGLE_API_PROXY` | no | instance fallback HTTP(S) forward proxy with an explicit port for Google generation, credential tests, embeddings, images and reply analysis. A workspace proxy saved in Settings overrides it. An authenticated URL is accepted; keep it secret. Unset uses direct Google access. Set it for both API and worker; Compose passes the same value to each. |
| 2026-09-26 | `GOOGLE_PROXY_ALLOWED_HOSTS` | no | comma-separated `host:port` destinations workspace admins may save as Google proxies in Settings. An existing `GOOGLE_API_PROXY` host and port are also allowed. No destination is accepted without either approval. This list contains no proxy passwords. |

The three required ones stop `docker compose up` outright, so an upgrade cannot
miss them. The optional ones are worth reading: an `.env` written
in August leaves registration on its self-closing default and the shipped ports
unchanged, which is a sane instance — but not necessarily the one you meant.

The same bound is what the worker's five-minute maintenance sweep uses to decide
that a scheduled or queued post whose queue job has been deleted by retention is
stranded rather than waiting. That sweep has **no environment variable of its
own** and needs none: it rides the cadence the abandoned-attempt sweep already
runs on, and the thing it recovers from has been true for hours by the time a
row is a candidate, so a poll five minutes wide adds a rounding error to it.

**Deploy the worker before the api, or both at once.** `docker compose up -d
--build` rebuilds both together and needs no further care. If you roll services
one at a time — a second host, an orchestrator, a manual restart — the order
matters for stored credentials: the api WRITES them and the worker READS them,
and a release can teach the reader a new format before the writer produces it,
but not the other way round. A worker on the previous release cannot open a
credential the new api has saved, and a post on that channel fails permanently
— with the crypto library's own "Unsupported state or unable to authenticate
data", since the previous release has no better sentence — until the worker
catches up.
The new worker reads everything the old api ever wrote, so worker first is
always safe. Pressing **Test connection** on an existing channel does not
change its stored format while `APP_ENCRYPTION_KEY` is a single key, so
channels nobody re-saves during the roll are unaffected in either order.

**Deploy web before the migration that adds `partially_published`.** Same
situation seen from the browser, and it applies to this one upgrade. A post
whose channels disagreed — one live, one permanently refused — now has a status
of its own, and that migration BACKFILLS it onto posts that are already in that
state, so the api starts answering `partially_published` the moment the
migration commits. A web bundle from before the upgrade has no colour and no
translated word for it, and the damage is worse than a missing label: the
queue's sections are DERIVED from that bundle's own list of statuses, so a post
whose status is in none of them lands in no section and is not drawn at all.
It disappears from the one screen people look at — filter chip included, so
there is no way to reach it — until web is upgraded. `docker compose up -d --build`
rebuilds everything together and needs no care here either; only a
service-at-a-time roll has to put web first.

## Configuration

Every variable is documented in [.env.example](../.env.example). Variables
marked optional have safe defaults.
