import { MemoryStorage } from "@mtcute/core";
import { TelegramClient } from "@mtcute/node";

/** One ephemeral maintained MTProto client; sessions never enter durable local storage. */
export function createClient(credentials: { apiId: number; apiHash: string }): TelegramClient {
  return new TelegramClient({ ...credentials, storage: new MemoryStorage() });
}
