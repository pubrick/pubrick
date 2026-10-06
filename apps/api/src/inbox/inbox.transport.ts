import { Injectable } from "@nestjs/common";
import { decryptJson } from "@pubrick/shared";
import { discussionAccount, readDiscussion, replyToDiscussion } from "@pubrick/telegram";
import { conflict } from "../api-error";
import { env } from "../env";

/** Injectable boundary for local deterministic transport fixtures; never exposes provider errors. */
@Injectable()
export class InboxTransport {
  private credentials(cipher: string) {
    if (!env.TELEGRAM_API_ID || !env.TELEGRAM_API_HASH)
      throw conflict(
        "inbox_account_unavailable",
        "Configure the Telegram application and connect a workspace account",
      );
    const decrypted: unknown = decryptJson(cipher, env.APP_ENCRYPTION_KEY);
    if (
      !decrypted ||
      typeof decrypted !== "object" ||
      !("session" in decrypted) ||
      typeof decrypted.session !== "string"
    )
      throw conflict("inbox_account_unavailable", "Reconnect the workspace Telegram account");
    return {
      apiId: env.TELEGRAM_API_ID,
      apiHash: env.TELEGRAM_API_HASH,
      session: decrypted.session,
    };
  }
  account(cipher: string) {
    return discussionAccount(this.credentials(cipher));
  }
  collect(cipher: string, input: Parameters<typeof readDiscussion>[1]) {
    return readDiscussion(this.credentials(cipher), input);
  }
  reply(cipher: string, input: Parameters<typeof replyToDiscussion>[1]) {
    return replyToDiscussion(this.credentials(cipher), input);
  }
}
