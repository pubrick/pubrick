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

# Set POSTGRES_PASSWORD in .env as well, then start:
docker compose up -d
```

If either secret is missing, `docker compose up` stops immediately with
`required variable BETTER_AUTH_SECRET is missing a value: set it in .env …`.
`APP_ENCRYPTION_KEY` must base64-decode to exactly 32 bytes — the api refuses
to boot otherwise. It encrypts channel credentials at rest, so back it up:
losing or changing it makes every stored credential unreadable.

Only the web app publishes a port (`3000`); the api is bound to `127.0.0.1:3001`
and reached through the web proxy. Put your TLS terminator in front of port 3000.

If the app is reachable at a public URL, also set `PUBLIC_ORIGIN` (e.g.
`https://your-domain.example`) so auth cookies and redirects use the right
origin.

Database migrations run automatically when the api container starts.

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
