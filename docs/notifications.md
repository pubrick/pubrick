# Telegram notifications

Configure a private Telegram bot and destination chat in **Settings → Notifications**. The organization owns this destination; it is separate from publishing channels. Pubrick encrypts the token and chat ID at rest and never returns either from the API. The first save requires both values. Later saves can leave both fields blank to keep the stored values. A **Test** action sends one real message.

Self-hosters with restricted Telegram egress can set `TELEGRAM_API_BASE_URL` to a compatible Bot API proxy; Compose passes it to both the API (Test) and worker (event delivery).

Notifications are off until explicitly enabled. Draft-ready alerts are off by default. Delivery failures and unknown outcomes are selected by default, but they are sent only after notifications are enabled. Unknown means the post may already be live; inspect the channel before retrying. Each Telegram alert has an Open post URL button to the configured public origin (`PUBLIC_ORIGIN` in Compose).

Events are inserted in the same database transaction as a successful generation or terminal delivery failure. Delivery alerts are deduplicated per publication attempt, so an editor's later retry can still produce a fresh alert. A separate worker poll claims the event before calling Telegram, so notification traffic cannot cause a generation retry or duplicate a publication. A network failure or worker crash after the claim leaves an unconfirmed event; Pubrick does not automatically resend it because Telegram might already have received it. The status remains in the database for operator inspection, while the draft or delivery receipt remains visible in the app. Disabling notifications before delivery skips pending alerts.

The first slice covers generated drafts and terminal delivery failures/unknown outcomes. It does not send a success ping for every publication, a morning digest, or interactive approve/reject bot callbacks. Notification messages use plain text, with no HTML parse mode or user-authored text, so titles and provider errors cannot inject markup or leak secrets through alerts.
