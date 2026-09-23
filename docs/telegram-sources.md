# Telegram channel sources

Pubrick reads public Telegram channels through [mtcute](https://mtcute.dev/guide/intro/sign-in), an MIT-licensed MTProto library. The integration uses Telegram's user authorization. The Bot API cannot read arbitrary competitor channel histories.

## Connect a workspace

1. Create a Telegram application at <https://my.telegram.org/apps>. Put its `api_id` and `api_hash` in `TELEGRAM_API_ID` and `TELEGRAM_API_HASH` in the worker environment. Keep the hash private.
2. Set the worker's `DATABASE_URL` and `APP_ENCRYPTION_KEY` to the same database and key ring used by the API. Build the worker with `pnpm --filter @pubrick/worker build`. Find the intended workspace ID in the `organization` table (`SELECT id, name FROM organization;`).
3. On the trusted server terminal, run `pnpm --filter @pubrick/worker telegram:connect <organization-id>`. In Docker Compose, run `docker compose run --rm -it worker node dist/telegram-connect.cjs <organization-id>`. Enter the account phone, Telegram code, and optional 2FA password at the prompts. Repeat for each workspace that wants Telegram monitoring. Running the command again replaces that workspace's session.
4. In Brand → Sources, select Telegram and add a public channel URL such as `https://t.me/example_channel`. The first check is queued. The source row displays connection, configuration and access errors without showing Telegram's raw response.

Each organization has one independently encrypted session in `telegram_source_accounts`. It is never returned through the API or browser. An operator with access to the database and encryption key can still recover it; protect and back up the key. If the session is revoked in Telegram, run the connect command again. Removing the row for one organization disconnects its sources without touching another workspace.

After rotating `APP_ENCRYPTION_KEY`, keep the old key in the ring until this command has reconnected every workspace with a Telegram source account. Polling does not re-encrypt stored sessions.

The worker reads at most 50 recent text or caption posts per poll, with a minimum 15-minute interval and a 20-second connection deadline. Posts shorter than 50 characters, polls, protected posts and service messages are skipped, matching the original Content Factory's news filter. Posts are deduplicated by their public message URL and appear in the same brand news list as RSS entries. A person chooses whether to generate a draft; monitoring does not auto-publish. Media without text, private invite-only channels and discussion groups are outside this version. Public channels already joined by the connected account are supported by the same URL. Telegram source URLs must use the exact `https://t.me/<username>` shape; Pubrick never opens those URLs as a web feed.

## Collect comments on a story

Open **Comments** beside a Telegram story, then choose **Collect comments**. The worker reads up to 50 recent replies for that specific post through Telegram's `messages.getReplies` method. It does not scan a discussion group's general history or publish any reply. Short, link-only, mention-only and duplicate replies are skipped; authors and their account IDs are not stored. Each check replaces the prior sample, and checks are limited to once per story every 15 minutes.

The story shows separate states for an absent linked discussion, a linked discussion inaccessible to the workspace's Telegram account, and a failed check. A failed check preserves the last successful sample and labels it as such; an absent or inaccessible discussion clears it. A private linked discussion can be read only if the connected account is allowed to access it; Pubrick does not join it or use invite links automatically. Private invite-only source channels are still unsupported. Comment text is untrusted external content and is displayed as plain text. AI summaries and sentiment analysis are not included in this slice; future analysis must use the existing organization BYOK call path and usage ledger before enabling a paid model call.
