import { Injectable } from "@nestjs/common";
import { decryptJson } from "@pubrick/shared";
import { readChannel } from "@pubrick/telegram";
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
  async read(url: string, encryptedSession: string | null): Promise<FeedItem[]> {
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
    try {
      return await readChannel({
        apiId: Number(env.TELEGRAM_API_ID),
        apiHash: env.TELEGRAM_API_HASH,
        session: stored.session,
        url,
      });
    } catch (error) {
      if (error instanceof Error && error.message === "access_denied")
        throw new TelegramSourceError("telegram_access_denied");
      throw new TelegramSourceError("telegram_unavailable");
    }
  }
}
