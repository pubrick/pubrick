# Telegram notifications

Configure a private Telegram bot and destination chat in **Settings → Notifications**. The organization owns this destination; it is separate from publishing channels. Pubrick encrypts the token and chat ID at rest and never returns either from the API. The first save requires both values. Later saves can leave both fields blank to keep the stored values. A **Test** action sends one real message.

Self-hosters with restricted Telegram egress can set `TELEGRAM_API_BASE_URL` to a compatible Bot API proxy; Compose passes it to both the API (Test) and worker (event delivery).

Notifications are off until explicitly enabled. Draft-ready alerts are off by default. Delivery failures and unknown outcomes are selected by default, but they are sent only after notifications are enabled. Unknown means the post may already be live; inspect the channel before retrying. Delivery alerts have an **Open post** URL button to the configured public origin (`PUBLIC_ORIGIN` in Compose).

A draft-ready alert names the brand and saved post title (or **Untitled draft**).
**Review**, **Schedule** and **Publish** open the authenticated post page; opening
any link does not make a decision. **Reject** also remains a web link unless the
workspace has an active decision bot and the draft is eligible for private
confirmation. In that case it starts the private workflow below.

Draft alerts require a plain HTTPS `PUBLIC_ORIGIN` / `WEB_ORIGIN`. Configure the
public address before enabling them. An alert whose post left the draft queue
is skipped. Stale web links show the current post and its available controls.

## Private draft rejection

This optional workflow requires an active workspace decision bot and each
editor's verified connection. It has passed local scripted acceptance; public
Telegram interoperability still requires a separately verified live sandbox.

1. An owner or admin saves the notification bot and destination, enables draft
   alerts, and chooses **Enable account connections** on this settings page.
   Setup requires Pubrick's public HTTPS address and exclusive inbound ownership
   of the bot. An unrelated existing webhook is refused; use a separate bot.
2. Each editor opens **Your Telegram account → Connect**, follows the private bot
   link, and starts the bot. Back in Pubrick, **Refresh** shows the candidate
   account. Verify the displayed identity and choose **Confirm account**.
   Starting the Telegram bot alone never binds a Pubrick account.
3. **Reject** in an eligible alert opens a separate confirmation in that editor's
   private bot chat. Review the named draft, then choose its private **Reject**.
   **Cancel** leaves the draft unchanged. No Telegram button publishes content,
   approves a draft or invokes a model.
4. The final decision requires current editing access and the unchanged draft,
   including its channel text and media. Changed, expired, already delivered or
   otherwise ineligible drafts are refused. Open the current draft and start
   again rather than using an old confirmation. Successful rejection appears
   on the draft's web page and remains after reload.
5. **Unlink** on the same account card revokes that member's connection and
   outstanding confirmations. Disabling the workspace decision bot revokes its
   interactive authority; ordinary outbound notifications can retain web links.

A bot may be shared for outbound notifications in another workspace, which keeps
URL-only controls; this does not transfer inbound ownership or editor bindings.
Unconfirmed physical sends are not automatically repeated. Delivery history is
read-only: inspect the bot chat and current draft before taking further action.
An alert or callback alone does not mark a draft as read. Temporary capabilities
are bounded and expire within 30 minutes; private rejection rechecks access at
consumption. See [the verification receipt](reviews/2026-10-01-telegram-callbacks.md)
for precise native, browser and live-interoperability limits.

Events are inserted in the same database transaction as a successful generation or terminal delivery failure. Delivery alerts are deduplicated per publication attempt, so an editor's later retry can still produce a fresh alert. A separate worker poll claims the event before calling Telegram, so notification traffic cannot cause a generation retry or duplicate a publication. A network failure or worker crash after the claim leaves an unconfirmed event; Pubrick does not automatically resend it because Telegram might already have received it. The status remains in the database for operator inspection, while the draft or delivery receipt remains visible in the app. Disabling notifications before delivery skips pending alerts.

The delivery history records when an event was queued, when its first send attempt was claimed, and a closed diagnostic reason for skipped, failed, or unconfirmed outcomes. The claim atomically records an unconfirmed reason before any provider I/O; a crash cannot leave an unexplained in-flight event. Telegram's explicit rejection is distinguished from a network or uncertain provider outcome. No Telegram response body, exception, token, chat ID, or destination URL is stored in this journal or returned by the history API. Links to a post or brand appear only while that record still exists in the same organization. Older events may lack a reason or first-attempt time. Operators should check the Telegram chat before acting on an unconfirmed event; history does not offer a resend action.

**Settings → Notifications → Delivery history** shows the latest events for the active organization, 20 at a time, with a Load more action. Owners and admins can see each event type, its queue time, its last activity time when different, and the last delivery status. `Waiting to send` has not been claimed; `Delivery unconfirmed` means a send was claimed but receipt is uncertain; `Sent` was confirmed by Telegram; `Failed` was rejected or could not start; `Skipped` means the event was no longer enabled at delivery time. History is read-only and never resends an event. It does not expose bot credentials, destination IDs, message text, or provider errors. The Test action sends immediately and is not an outbox event, so it does not appear here.

The compact **Delivery summary** above history counts persisted events over the last 7 or 30 rolling 24-hour days. `GET /api/notifications/summary?days=7|30` is owner/admin-only and organization-scoped. The response includes one explicit half-open UTC window (`windowStart <= created_at < windowEnd`), a total, zero-filled counts for every closed event and delivery status, counts for every closed diagnostic reason, and `withoutReason` for rows with no diagnostic code. A missing code is normal on pending or sent events and can also occur on older records. `attempted` is unconfirmed and may already be delivered; it is not included with `failed` or `skipped`. The summary reads only the durable event journal and never contacts Telegram, reveals target IDs or credentials, or offers a resend action.

Daily digests are configured per brand on the same settings screen. Each brand defaults to off; enable Telegram notifications and that brand's digest, then choose a valid IANA timezone and local hour (0–23). The worker scans every five minutes and creates one immutable snapshot for each due brand and local date. If a daylight-saving transition skips the selected hour, that day's digest is skipped. If the hour occurs twice, the unique date key still produces one digest. No historical backfill runs when a digest is enabled. Disabling the brand digest before delivery skips its pending message.

The message covers the **previous local calendar day**: succeeded and failed generation runs started during that day, plus model-call USD spend attributed to generation runs during that day. It also includes the **current** number of draft content items awaiting review. If a provider cost is unknown or a run reports unrecorded calls, the spend is marked *at least*; it is never shown as a definitive total. Standalone image/refine/embedding calls without a generation run are outside this figure. The snapshot and event are committed together; concurrent scans cannot create two for the same brand/date. A send is claimed before Telegram I/O and ambiguous outcomes remain unconfirmed, never automatically retried.

Notifications do not send a success ping for every publication. Approval, scheduling and publication remain web decisions; only the private rejection workflow above has an interactive callback. Messages use plain text, with no HTML parse mode. Brand names are truncated to keep messages short; provider errors and credentials are never included.
