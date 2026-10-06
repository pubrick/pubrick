import { Long } from "@mtcute/core";
import type { TelegramClient } from "@mtcute/node";
import { createClient } from "./client.js";

export const DISCUSSION_WINDOW_SIZE = 50;
export type DiscussionIdentity = { peerId: number; rootId: number };
export type DiscussionMessage = {
  messageId: number;
  body: string;
  bodyTruncated: boolean;
  publishedAt: Date;
  editedAt: Date | null;
};
export type DiscussionPage = DiscussionIdentity & {
  messages: DiscussionMessage[];
  /** Raw provider IDs, including unreadable/media-only messages, advance the window. */
  oldestId: number | null;
  newestId: number | null;
  hasMore: boolean;
};
export type DiscussionAccount = { id: number; label: string };
export type DiscussionReplyReceipt = { messageId: number; url: string | null };
type Credentials = { apiId: number; apiHash: string; session: string };
type Discussion = NonNullable<Awaited<ReturnType<TelegramClient["getDiscussionMessage"]>>>;

/** Fixed safe codes only. Once create starts, every ambiguous failure stays unknown. */
export class DiscussionError extends Error {
  constructor(
    readonly code: "unavailable" | "target_changed" | "message_changed",
    readonly uncertain = false,
    readonly receipt?: DiscussionReplyReceipt,
  ) {
    super(code);
  }
}

async function bounded<T>(
  credentials: Credentials,
  action: (client: TelegramClient, alive: () => void, signal: AbortSignal) => Promise<T>,
  singleAttempt = false,
): Promise<T> {
  const client = createClient(credentials, { singleAttempt });
  let expired = false;
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const alive = () => {
    if (expired) throw new DiscussionError("unavailable", true);
  };
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true;
      abort.abort();
      void client.destroy().catch(() => undefined);
      reject(new DiscussionError("unavailable", true));
    }, 20_000);
  });
  try {
    return await Promise.race([
      deadline,
      (async () => {
        await client.importSession(credentials.session);
        alive();
        return action(client, alive, abort.signal);
      })(),
    ]);
  } finally {
    expired = true;
    abort.abort();
    if (timer) clearTimeout(timer);
    // Cleanup must not extend the network deadline when the SDK's shutdown is stuck.
    void client.destroy().catch(() => undefined);
  }
}

async function discussion(client: TelegramClient, postUrl: string): Promise<Discussion> {
  const parsed = /^https:\/\/t\.me\/([A-Za-z][A-Za-z0-9_]{4,31})\/([1-9]\d{0,9})$/.exec(postUrl);
  const handle = parsed?.[1];
  const postId = parsed?.[2];
  if (!handle || !postId || Number(postId) > 2_147_483_647)
    throw new DiscussionError("unavailable");
  const root = await client.getDiscussionMessage({ chatId: handle, message: Number(postId) });
  if (
    !root ||
    root.isContentProtected ||
    !("isLikelyUnavailable" in root.chat) ||
    root.chat.isLikelyUnavailable ||
    !Number.isSafeInteger(root.chat.id)
  )
    throw new DiscussionError("unavailable");
  return root;
}

/** Unfiltered readable text, independent of the intentionally sampled AI analysis reader. */
export async function readDiscussion(
  credentials: Credentials,
  input: {
    postUrl: string;
    identity?: DiscussionIdentity;
    offsetId?: number;
    maxId?: number;
  },
): Promise<DiscussionPage> {
  return bounded(credentials, async (client, alive) => {
    const root = await discussion(client, input.postUrl);
    if (
      input.identity &&
      (root.chat.id !== input.identity.peerId || root.id !== input.identity.rootId)
    )
      throw new DiscussionError("target_changed");
    alive();
    const page = await client.call({
      _: "messages.getReplies",
      peer: root.chat.inputPeer,
      msgId: root.id,
      offsetId: input.offsetId ?? 0,
      offsetDate: 0,
      addOffset: 0,
      limit: DISCUSSION_WINDOW_SIZE,
      maxId: input.maxId ?? 0,
      minId: 0,
      hash: Long.ZERO,
    });
    if (page._ === "messages.messagesNotModified") throw new DiscussionError("unavailable");
    const ids = page.messages.filter((m) => m.id > 0).map((m) => m.id);
    const messages: DiscussionMessage[] = page.messages.flatMap((m) => {
      if (m._ !== "message" || m.id === root.id || m.noforwards) return [];
      const text = m.message.replaceAll("\u0000", "");
      if (!text.trim()) return []; // Media-only messages are outside this text inbox's capability.
      return [
        {
          messageId: m.id,
          body: text.slice(0, 4000),
          bodyTruncated: text.length > 4000,
          publishedAt: new Date(m.date * 1000),
          editedAt: m.editDate ? new Date(m.editDate * 1000) : null,
        },
      ];
    });
    return {
      peerId: root.chat.id,
      rootId: root.id,
      messages,
      oldestId: ids.length ? Math.min(...ids) : null,
      newestId: ids.length ? Math.max(...ids) : null,
      hasMore: page.messages.length === DISCUSSION_WINDOW_SIZE,
    };
  });
}

/** Preflight reads precede the caller's freshly locked authority check. Never retries a create. */
export async function replyToDiscussion(
  credentials: Credentials,
  input: {
    postUrl: string;
    identity: DiscussionIdentity;
    message: DiscussionMessage;
    body: string;
    randomId: string;
    expectedAccountId: number;
    beforeSend: (
      account: DiscussionAccount,
      create: (signal?: AbortSignal) => Promise<DiscussionReplyReceipt>,
    ) => Promise<DiscussionReplyReceipt>;
  },
): Promise<DiscussionReplyReceipt> {
  let createStarted = false;
  let acceptedReceipt: DiscussionReplyReceipt | undefined;
  try {
    return await bounded(
      credentials,
      async (client, alive, networkSignal) => {
        const root = await discussion(client, input.postUrl);
        if (root.chat.id !== input.identity.peerId || root.id !== input.identity.rootId)
          throw new DiscussionError("target_changed");
        const [target] = await client.getMessages(root.chat.inputPeer, input.message.messageId);
        if (
          !target ||
          target.isContentProtected ||
          target.isService ||
          (target.replyToMessage?.threadId ?? target.replyToMessage?.id) !== root.id ||
          target.text.replaceAll("\u0000", "").slice(0, 4000) !== input.message.body ||
          Boolean(target.text.replaceAll("\u0000", "").length > 4000) !==
            input.message.bodyTruncated ||
          (target.editDate?.getTime() ?? null) !== (input.message.editedAt?.getTime() ?? null)
        )
          throw new DiscussionError("message_changed");
        const me = await client.getMe();
        if (me.id !== input.expectedAccountId) throw new DiscussionError("target_changed");
        alive();
        return input.beforeSend(
          { id: me.id, label: me.username ? `@${me.username}` : me.displayName },
          async (authoritySignal) => {
            alive();
            authoritySignal?.throwIfAborted();
            createStarted = true;
            const sent = await client.sendText(
              root.chat.inputPeer,
              { text: input.body, entities: [] },
              {
                replyTo: target.id,
                threadId: root.id,
                sendAs: "me",
                randomId: Long.fromString(input.randomId),
                disableWebPreview: true,
                abortSignal: authoritySignal
                  ? AbortSignal.any([networkSignal, authoritySignal])
                  : networkSignal,
              },
            );
            let url: string | null = null;
            try {
              url = sent.link;
            } catch {
              /* ID still proves acceptance when a permalink is unavailable. */
            }
            acceptedReceipt = { messageId: sent.id, url };
            return acceptedReceipt;
          },
        );
      },
      true,
    );
  } catch (error) {
    if (error instanceof DiscussionError && !createStarted)
      throw new DiscussionError(error.code, false);
    throw new DiscussionError("unavailable", createStarted, acceptedReceipt);
  }
}

export async function discussionAccount(credentials: Credentials): Promise<DiscussionAccount> {
  return bounded(credentials, async (client) => {
    const me = await client.getMe();
    return { id: me.id, label: me.username ? `@${me.username}` : me.displayName };
  });
}
