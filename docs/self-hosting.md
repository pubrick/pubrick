# Self-hosting Pubrick

## Requirements

- Docker with Compose v2
- 1 GB RAM minimum for the skeleton; Postgres data lives in the `pgdata` volume

## Install

```bash
git clone https://github.com/pubrick/pubrick && cd pubrick
cp .env.example .env

# Generate two separate secrets and paste each into .env, replacing the
# placeholder values of BETTER_AUTH_SECRET and APP_ENCRYPTION_KEY.
# Compose has no fallback defaults and refuses to start until both are real.
openssl rand -base64 32
openssl rand -base64 32

# Set POSTGRES_PASSWORD and PUBLIC_ORIGIN in .env as well, then start:
docker compose up -d
```

Three variables are required and have no defaults; `docker compose up` stops
immediately with `required variable X is missing a value: …` if any is unset.

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

Neither secret may be a value published in this repository — the api refuses to
start in production on the old `init.sh` fallbacks or the `.env.example`
placeholders, rather than running on a key anyone can read off GitHub.

Only the web app publishes a port (`3000`); the api is bound to `127.0.0.1:3001`
and reached through the web proxy. Put your TLS terminator in front of port 3000.

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

Each key is validated at boot, so a typo in the second one is a refusal to start
rather than a credential that silently cannot be read months later. Every key in
the ring is also checked against the values published in this repository — a
rotation cannot smuggle the example key into second place.

If a credential does become unreadable — the key was dropped, or a row was
tampered with — the product says so in one sentence everywhere it is noticed:
the channel's connection test, the AI key's Test button, a failed post's error,
and a failed generation all report that the stored credentials were encrypted
with a key this instance no longer has. Restore the old key, or save the
credentials again.

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

**Adding people.** An owner or admin invites an address from their organization
(organization → invite member). The invitee then registers with exactly that
address — the pending invitation is what lets their sign-up through — and accepts
the invitation. Invitations expire after 48 hours; a stale one no longer opens
the door.

Email verification is not required, and there is no built-in mailer: Pubrick does
not send the invitation for you, so pass the invite link to the person yourself.

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

## Configuration

Every variable is documented in [.env.example](../.env.example). Variables
marked optional have safe defaults.
