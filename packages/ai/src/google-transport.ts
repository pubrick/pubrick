import { TransientError } from "@pubrick/shared";
import { ProxyAgent } from "undici";
import { z } from "zod";

/** An HTTP CONNECT proxy, not a replacement Gemini API origin. */
export const googleProxyEnvSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .string()
    .refine((value) => {
      try {
        const url = new URL(value);
        // URL normalizes explicit default ports (http:80, https:443) away, so
        // inspect the original authority when enforcing the documented shape.
        const authority = value.split("://", 2)[1]?.split(/[/?#]/, 1)[0] ?? "";
        const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !!url.hostname &&
          /:\d+$/.test(hostPort) &&
          url.pathname === "/" &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    }, "GOOGLE_API_PROXY must be an http(s) proxy URL with an explicit port and no path, query or fragment")
    .optional(),
);

let cachedUrl: string | undefined;
let cachedAgent: ProxyAgent | undefined;

/** Keep the proxy URL and its optional credentials entirely in the server process. */
export async function googleProxyFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = googleProxyEnvSchema.parse(process.env.GOOGLE_API_PROXY);
  if (!url) return fetch(input, init);
  // Node's fetch accepts undici's dispatcher extension. The DOM RequestInit
  // type omits it, but the same dispatcher also drives @ai-sdk/google's fetch.
  try {
    if (cachedUrl !== url || !cachedAgent) {
      cachedAgent = new ProxyAgent(url);
      cachedUrl = url;
    }
    return await fetch(input, { ...init, dispatcher: cachedAgent } as RequestInit);
  } catch {
    // A transport exception can carry the proxy URL and userinfo. It also
    // might follow an upstream charge, so callers keep their existing ledger
    // and ambiguity policies, while jobs may retry a temporary proxy outage.
    throw new TransientError("Gemini proxy transport failed");
  }
}
