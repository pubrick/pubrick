import { MemoryStorage } from "@mtcute/core";
import { TelegramClient } from "@mtcute/node";

export type Credentials = { apiId: number; apiHash: string };

const LOGIN_TIMEOUT_MS = 20_000;

/** Each HTTP step owns a fresh in-memory MTProto client and a finite deadline. */
async function withLoginClient<T>(
  credentials: Credentials,
  action: (client: TelegramClient, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const client = new TelegramClient({ ...credentials, storage: new MemoryStorage() });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("unavailable"));
    }, LOGIN_TIMEOUT_MS);
  });
  try {
    return await Promise.race([action(client, controller.signal), deadline]);
  } catch (error) {
    if (error instanceof Error && error.message === "unavailable") throw error;
    const code =
      typeof error === "object" && error !== null && "text" in error ? String(error.text) : "";
    if (code === "SESSION_PASSWORD_NEEDED") throw new Error("password_required");
    if (["PHONE_NUMBER_INVALID", "PHONE_NUMBER_BANNED"].includes(code))
      throw new Error("invalid_phone");
    if (["PHONE_CODE_INVALID", "PHONE_CODE_EMPTY"].includes(code)) throw new Error("invalid_code");
    if (["PHONE_CODE_EXPIRED", "PHONE_CODE_HASH_INVALID"].includes(code))
      throw new Error("code_expired");
    if (code === "PASSWORD_HASH_INVALID") throw new Error("invalid_password");
    if (/^(?:FLOOD_WAIT|PHONE_NUMBER_FLOOD|PHONE_PASSWORD_FLOOD)/.test(code))
      throw new Error("rate_limited");
    // mtcute errors can carry phone numbers and RPC details. Never forward them.
    throw new Error("unavailable");
  } finally {
    if (timer) clearTimeout(timer);
    // A timeout must not leave an MTProto connection alive. Bound teardown too.
    let teardownTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        client.destroy().catch(() => undefined),
        new Promise<void>((resolve) => {
          teardownTimer = setTimeout(resolve, LOGIN_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (teardownTimer) clearTimeout(teardownTimer);
    }
  }
}

/** Start a resumable phone login. The session and code hash are server-only secrets. */
export async function beginTelegramLogin(
  credentials: Credentials,
  phone: string,
): Promise<{ session: string; phoneCodeHash: string; codeLength?: number }> {
  return withLoginClient(credentials, async (client, signal) => {
    const sent = await client.sendCode({ phone, abortSignal: signal });
    if (!("phoneCodeHash" in sent)) throw new Error("unavailable");
    return {
      session: await client.exportSession(),
      phoneCodeHash: sent.phoneCodeHash,
      codeLength: sent.length,
    };
  });
}

/** Submit a one-time code; 2FA retains the same private session for the next step. */
export async function submitTelegramCode(
  credentials: Credentials,
  session: string,
  phone: string,
  phoneCodeHash: string,
  code: string,
): Promise<
  | { status: "authorized"; session: string }
  | { status: "password_required"; session: string; passwordHint?: string }
> {
  return withLoginClient(credentials, async (client, signal) => {
    await client.importSession(session);
    try {
      await client.signIn({ phone, phoneCodeHash, phoneCode: code, abortSignal: signal });
      return { status: "authorized", session: await client.exportSession() };
    } catch (error) {
      const codeText =
        typeof error === "object" && error !== null && "text" in error ? String(error.text) : "";
      if (codeText !== "SESSION_PASSWORD_NEEDED") throw error;
      // A missing hint must not discard a valid 2FA challenge.
      const passwordHint = await client.getPasswordHint().catch(() => null);
      return {
        status: "password_required",
        session: await client.exportSession(),
        ...(passwordHint ? { passwordHint } : {}),
      };
    }
  });
}

/** Complete a 2FA challenge without exposing the password or authorized session to a browser. */
export async function submitTelegramPassword(
  credentials: Credentials,
  session: string,
  password: string,
): Promise<{ session: string }> {
  return withLoginClient(credentials, async (client, signal) => {
    await client.importSession(session);
    await client.checkPassword({ password, abortSignal: signal });
    return { session: await client.exportSession() };
  });
}
