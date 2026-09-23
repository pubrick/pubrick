import password from "@inquirer/password";
import { MemoryStorage } from "@mtcute/core";
import { TelegramClient } from "@mtcute/node";

export type ChannelPost = { title: string; summary: string; url: string; publishedAt: Date };
type Credentials = { apiId: number; apiHash: string };

function createClient(credentials: Credentials): TelegramClient {
  return new TelegramClient({ ...credentials, storage: new MemoryStorage() });
}

/** Interactive, terminal-only user sign-in (phone, OTP and optional 2FA). */
export async function connectSession(credentials: Credentials): Promise<string> {
  const client = createClient(credentials);
  try {
    await client.start({
      phone: () => password({ message: "Telegram phone", mask: false }),
      code: () => password({ message: "Telegram code", mask: false }),
      password: () => password({ message: "Telegram 2FA password", mask: false }),
    });
    return await client.exportSession();
  } finally {
    await client.destroy();
  }
}

/** Read a bounded batch; mtcute owns MTProto, while the caller owns tenant scoping. */
export async function readChannel(
  input: Credentials & { session: string; url: string },
): Promise<ChannelPost[]> {
  const handle = new URL(input.url).pathname.slice(1).replace(/\/$/, "");
  const client = createClient(input);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void client.destroy().catch(() => undefined);
      reject(new Error("unavailable"));
    }, 20_000);
  });
  try {
    return await Promise.race([
      (async () => {
        await client.importSession(input.session);
        const chat = await client.getChat(handle);
        if (chat.chatType !== "channel") throw new Error("access_denied");
        const messages = await client.getHistory(handle, { limit: 50 });
        return messages.flatMap((message) => {
          if (
            !message.isChannelPost ||
            message.isService ||
            message.isContentProtected ||
            message.media?.type === "poll"
          )
            return [];
          const body = message.text.replaceAll("\u0000", "").trim();
          if (body.length < 50) return [];
          return [
            {
              title:
                body
                  .split("\n")
                  .find((line) => line.trim())
                  ?.slice(0, 100) ?? body.slice(0, 100),
              summary: body.slice(0, 8000),
              url: `https://t.me/${handle}/${message.id}`,
              publishedAt: message.date,
            },
          ];
        });
      })(),
      deadline,
    ]);
  } catch (error) {
    if (error instanceof Error && error.message === "access_denied") throw error;
    const code =
      typeof error === "object" && error !== null && "text" in error ? String(error.text) : "";
    if (
      [
        "CHANNEL_PRIVATE",
        "CHAT_ADMIN_REQUIRED",
        "USERNAME_NOT_OCCUPIED",
        "AUTH_KEY_UNREGISTERED",
        "SESSION_REVOKED",
      ].includes(code)
    )
      throw new Error("access_denied");
    throw new Error("unavailable");
  } finally {
    clearTimeout(timer);
    await client.destroy().catch(() => undefined);
  }
}
