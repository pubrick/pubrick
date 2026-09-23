import { encryptJson } from "@pubrick/shared";
import { connectSession } from "@pubrick/telegram";
import { pool } from "./db";
import { env } from "./env";
import { RssRepository } from "./rss/rss.repository";

async function main(): Promise<void> {
  const orgId = process.argv[2];
  if (!orgId || !/^[0-9a-z_-]{8,128}$/i.test(orgId)) {
    throw new Error("Pass the workspace organization ID as the first argument");
  }
  if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH) {
    throw new Error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH before connecting Telegram");
  }
  try {
    const session = await connectSession({
      apiId: Number(env.TELEGRAM_API_ID),
      apiHash: env.TELEGRAM_API_HASH,
    });
    await new RssRepository().connectTelegram(
      orgId,
      encryptJson({ session }, env.APP_ENCRYPTION_KEY),
    );
    process.stdout.write(`Telegram source account connected for workspace ${orgId}.\n`);
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  process.stderr.write(
    "Telegram connection failed. Check workspace ID, credentials, and Telegram access.\n",
  );
  process.exitCode = 1;
});
