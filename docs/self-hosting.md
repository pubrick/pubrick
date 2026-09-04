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
  list all come from it: an install that leaves it wrong signs people out with a
  403 `Invalid origin`, and one left on `http://` behind TLS serves session
  cookies without the `Secure` attribute.

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
everyone in the organization, and **Invite** asks for an address. *Any* member
can invite — Pubrick has no owner/admin distinction anywhere in its interface,
so it does not pretend to have one here.

Pubrick has no mailer, so it does not send the invitation for you. What you get
back is a link to this instance, which you pass to the person yourself. It is
shown once, in the dialog that created it; inviting the same address again
replaces the invitation and mints a new link, which is how you re-issue one
somebody lost — and which stops the old link working.

The invitee opens the link, creates an account **with exactly the address you
invited**, and lands on a screen offering the organization by name; one click
joins it. Every member sees the pending invitations on the same Workspace card
and can **Remove** any of them.

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

## Upgrade

```bash
git pull
docker compose up -d --build
```

Migrations apply on boot; back up the `pgdata` volume before major upgrades.

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

## Configuration

Every variable is documented in [.env.example](../.env.example). Variables
marked optional have safe defaults.
