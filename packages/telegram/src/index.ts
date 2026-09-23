import password from "@inquirer/password";
import { Long, MemoryStorage } from "@mtcute/core";
import { TelegramClient } from "@mtcute/node";

export type ChannelPost = { title: string; summary: string; url: string; publishedAt: Date };
export type ChannelComment = { messageId: number; body: string; publishedAt: Date };
export type ChannelComments = {
  status: "available" | "unavailable" | "private";
  comments: ChannelComment[];
};
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
  const client = createClient({ apiId: input.apiId, apiHash: input.apiHash });
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

/** Read only the replies to one public post, never the discussion group's general history. */
export async function readComments(
  input: Credentials & { session: string; url: string },
): Promise<ChannelComments> {
  const parsed = new URL(input.url);
  const [handle, rawMessageId] = parsed.pathname.slice(1).split("/");
  const messageId = Number(rawMessageId);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "t.me" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !/^\/[a-zA-Z0-9_]{5,32}\/\d+$/.test(parsed.pathname) ||
    !handle ||
    !/^[a-zA-Z0-9_]{5,32}$/.test(handle) ||
    !Number.isSafeInteger(messageId) ||
    messageId < 1
  )
    throw new Error("unavailable");
  const client = createClient({ apiId: input.apiId, apiHash: input.apiHash });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      void client.destroy().catch(() => undefined);
      reject(new Error("unavailable"));
    }, 20_000);
  });
  try {
    return await Promise.race([
      (async (): Promise<ChannelComments> => {
        await client.importSession(input.session);
        const discussion = await client.getDiscussionMessage({
          chatId: handle,
          message: messageId,
        });
        if (!discussion) return { status: "unavailable", comments: [] };
        const result = await client.call({
          _: "messages.getReplies",
          peer: discussion.chat.inputPeer,
          msgId: discussion.id,
          offsetId: 0,
          offsetDate: 0,
          addOffset: 0,
          limit: 50,
          maxId: 0,
          minId: 0,
          hash: Long.ZERO,
        });
        if (result._ === "messages.messagesNotModified") throw new Error("unavailable");
        const seen = new Set<string>();
        const comments = result.messages.flatMap((message): ChannelComment[] => {
          if (message._ !== "message" || message.id === discussion.id || message.noforwards)
            return [];
          const body = message.message.replaceAll("\u0000", "").trim().slice(0, 4000);
          if (body.length < 15 || /^https?:\/\/\S+$/i.test(body) || /^@\w+$/.test(body)) return [];
          const normalized = body
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, " ")
            .trim();
          if (!normalized || seen.has(normalized)) return [];
          seen.add(normalized);
          return [{ messageId: message.id, body, publishedAt: new Date(message.date * 1000) }];
        });
        return { status: "available", comments };
      })(),
      deadline,
    ]);
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "text" in error ? String(error.text) : "";
    if (
      [
        "CHANNEL_PRIVATE",
        "CHAT_ADMIN_REQUIRED",
        "PEER_ID_INVALID",
        "USER_BANNED_IN_CHANNEL",
      ].includes(code)
    )
      return { status: "private", comments: [] };
    if (code === "MSG_ID_INVALID") return { status: "unavailable", comments: [] };
    throw new Error("unavailable");
  } finally {
    clearTimeout(timer);
    await client.destroy().catch(() => undefined);
  }
}
