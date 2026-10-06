import { MemoryStorage, networkMiddlewares } from "@mtcute/core";
import { TelegramClient } from "@mtcute/node";

/** One ephemeral maintained MTProto client; sessions never enter durable local storage. */
export function createClient(
  credentials: { apiId: number; apiHash: string },
  options?: { singleAttempt: boolean },
): TelegramClient {
  return new TelegramClient({
    ...credentials,
    storage: new MemoryStorage(),
    ...(options?.singleAttempt
      ? {
          // A fresh human authority fence covers one logical create. The SDK must not retry/sleep after it.
          middlewares: networkMiddlewares.basic({
            internalErrors: {
              maxRetries: 0,
              waitTime: 0,
              exceptErrors: ["WORKER_BUSY_TOO_LONG_RETRY"],
            },
            floodWaiter: { maxRetries: 0, maxWait: 0, store: false },
          }),
        }
      : {}),
  });
}
