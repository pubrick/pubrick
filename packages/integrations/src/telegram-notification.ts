/** A notification send is one attempt. An unknown HTTP outcome is never retried. */
export type TelegramNotificationResult = "sent" | "rejected" | "unknown";

export async function sendTelegramNotification(
  credentials: { botToken: string; chatId: string },
  text: string,
  options: {
    baseUrl?: string;
    button?: { text: string; url: string };
    buttons?: readonly { text: string; url: string }[];
    buttonRows?: readonly (readonly { text: string; url: string }[])[];
    fetchImpl?: typeof fetch;
  } = {},
): Promise<TelegramNotificationResult> {
  const buttonRows = (
    options.buttonRows?.length
      ? options.buttonRows
      : options.buttons?.length
        ? [options.buttons]
        : options.button
          ? [[options.button]]
          : []
  )
    .map((row) => row.map(({ text, url }) => ({ text, url })))
    .filter((row) => row.length > 0);
  try {
    const response = await (options.fetchImpl ?? fetch)(
      `${options.baseUrl ?? "https://api.telegram.org"}/bot${credentials.botToken}/sendMessage`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          chat_id: credentials.chatId,
          text,
          ...(buttonRows.length ? { reply_markup: { inline_keyboard: buttonRows } } : {}),
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (response.status >= 500) return "unknown";
    if (!response.ok) return "rejected";
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("ok" in body)) return "unknown";
    return body.ok === true ? "sent" : "rejected";
  } catch {
    // Fetch errors can include the token-bearing URL. Never return or log one.
    return "unknown";
  }
}
