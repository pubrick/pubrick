import { Injectable } from "@nestjs/common";
import { decryptJson } from "@pubrick/shared";
import {
  type ChannelComments,
  type PrivateChannelPeer,
  readChannel,
  readComments,
  readPrivateChannel,
} from "@pubrick/telegram";
import { env } from "../env";
import type { FeedItem } from "./rss.fetcher";

export type TelegramSourceErrorCode =
  | "telegram_not_connected"
  | "telegram_not_configured"
  | "telegram_access_denied"
  | "telegram_unavailable";

export class TelegramSourceError extends Error {
  constructor(readonly code: TelegramSourceErrorCode) {
    super(code);
  }
}

@Injectable()
export class TelegramReader {
  private session(encryptedSession: string | null): string {
    if (!encryptedSession) throw new TelegramSourceError("telegram_not_connected");
    if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH)
      throw new TelegramSourceError("telegram_not_configured");
    let stored: unknown;
    try {
      stored = decryptJson(encryptedSession, env.APP_ENCRYPTION_KEY);
    } catch {
      throw new TelegramSourceError("telegram_not_connected");
    }
    if (
      !stored ||
      typeof stored !== "object" ||
      !("session" in stored) ||
      typeof stored.session !== "string"
    ) {
      throw new TelegramSourceError("telegram_not_connected");
    }
    return stored.session;
  }

  private async call<T>(
    operation: (session: string) => Promise<T>,
    encryptedSession: string | null,
  ): Promise<T> {
    const session = this.session(encryptedSession);
    try {
      return await operation(session);
    } catch (error) {
      if (error instanceof Error && error.message === "access_denied")
        throw new TelegramSourceError("telegram_access_denied");
      throw new TelegramSourceError("telegram_unavailable");
    }
  }

  async read(url: string, encryptedSession: string | null): Promise<FeedItem[]> {
    return this.call(
      (session) =>
        readChannel({
          apiId: Number(env.TELEGRAM_API_ID),
          apiHash: env.TELEGRAM_API_HASH ?? "",
          session,
          url,
        }),
      encryptedSession,
    );
  }

  async readPrivate(
    encryptedPeer: string | null,
    encryptedSession: string | null,
  ): Promise<FeedItem[]> {
    let peer: PrivateChannelPeer;
    try {
      const stored = encryptedPeer ? decryptJson(encryptedPeer, env.APP_ENCRYPTION_KEY) : null;
      if (
        !stored ||
        typeof stored !== "object" ||
        !("channelId" in stored) ||
        !("accessHash" in stored) ||
        !Number.isSafeInteger(stored.channelId) ||
        typeof stored.accessHash !== "string"
      )
        throw new Error("invalid peer");
      peer = stored as PrivateChannelPeer;
    } catch {
      throw new TelegramSourceError("telegram_access_denied");
    }
    return this.call(
      (session) =>
        readPrivateChannel({
          apiId: Number(env.TELEGRAM_API_ID),
          apiHash: env.TELEGRAM_API_HASH ?? "",
          session,
          peer,
        }),
      encryptedSession,
    );
  }

  async comments(url: string, encryptedSession: string | null): Promise<ChannelComments> {
    return this.call(
      (session) =>
        readComments({
          apiId: Number(env.TELEGRAM_API_ID),
          apiHash: env.TELEGRAM_API_HASH ?? "",
          session,
          url,
        }),
      encryptedSession,
    );
  }
}
