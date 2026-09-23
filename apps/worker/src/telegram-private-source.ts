import password from "@inquirer/password";
import { decryptJson, encryptJson, newsSourceNameSchema } from "@pubrick/shared";
import { resolveJoinedPrivateChannel } from "@pubrick/telegram";
import { pool } from "./db";
import { env } from "./env";
import { RssRepository } from "./rss/rss.repository";

async function main(): Promise<void> {
  const [orgId, brandId, ...nameParts] = process.argv.slice(2);
  const name = nameParts.join(" ").trim();
  if (
    !orgId ||
    !/^[0-9a-z_-]{8,128}$/i.test(orgId) ||
    !brandId ||
    !/^[0-9a-f-]{36}$/i.test(brandId) ||
    name.length > 120
  ) {
    throw new Error("Pass a workspace ID, brand UUID and optional source name");
  }
  if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH)
    throw new Error("Telegram application credentials are not configured");

  const sources = new RssRepository();
  const encryptedSession = await sources.telegramSession(orgId);
  if (!encryptedSession) throw new Error("Connect this workspace's Telegram account first");
  const stored: unknown = decryptJson(encryptedSession, env.APP_ENCRYPTION_KEY);
  if (
    !stored ||
    typeof stored !== "object" ||
    !("session" in stored) ||
    typeof stored.session !== "string"
  )
    throw new Error("Invalid Telegram session");

  // A hidden TTY prompt keeps the invite out of argv, shell history and API logs.
  const invite = await password({ message: "Joined private channel invite URL", mask: "*" });
  const resolved = await resolveJoinedPrivateChannel({
    apiId: Number(env.TELEGRAM_API_ID),
    apiHash: env.TELEGRAM_API_HASH,
    session: stored.session,
    invite,
  });
  const sourceName = newsSourceNameSchema.parse(name || resolved.title.slice(0, 120));
  await sources.addPrivateTelegramSource(
    orgId,
    brandId,
    sourceName,
    resolved.peer.channelId,
    encryptJson(resolved.peer, env.APP_ENCRYPTION_KEY),
  );
  process.stdout.write("Private Telegram channel added. It is visible in Brand → Sources.\n");
}

main()
  .catch(() => {
    process.stderr.write(
      "Private channel setup failed. Check workspace, brand, membership and Telegram access.\n",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
