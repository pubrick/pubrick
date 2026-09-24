import { createHmac } from "node:crypto";
import { guardedFetch } from "guarded-fetch";

export type WebhookEnvelope = {
  id: string;
  event: string;
  createdAt: string;
  data: Record<string, unknown>;
};

export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** No redirects or response body reads. The library pins checked public DNS answers. */
export async function postWebhook(
  url: string,
  secret: string,
  envelope: WebhookEnvelope,
  fetcher: typeof guardedFetch = guardedFetch,
): Promise<number> {
  const body = JSON.stringify(envelope);
  const timestamp = Math.floor(Date.now() / 1000);
  const response = await fetcher(url, {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "Pubrick-Webhooks/1",
      "X-Pubrick-Event-Id": envelope.id,
      "X-Pubrick-Timestamp": String(timestamp),
      "X-Pubrick-Signature": signWebhook(secret, timestamp, body),
    },
    httpsOnly: true,
    followRedirects: false,
    timeoutMs: 5_000,
    opaqueErrors: true,
  });
  // We need only the status. Never buffer an attacker-controlled response body.
  try {
    await response.body?.cancel();
  } catch {
    // The HTTP status is already known; a body cancellation is not ambiguity.
  }
  return response.status;
}
