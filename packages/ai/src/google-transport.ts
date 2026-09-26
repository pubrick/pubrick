import { PermanentError, TransientError } from "@pubrick/shared";
import { ProxyAgent } from "undici";
import { z } from "zod";

const hostPortPattern = /^(?:[a-z0-9.-]+|\[[0-9a-f:]+\]):[0-9]{1,5}$/i;

function proxyDestination(value: string): string | null {
  // WHATWG URL treats a backslash as a path separator for http(s). Validate
  // the original syntax before using its canonical hostname for the allowlist.
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char === "\\" || char.trim() === "" || code < 32 || code === 127) return null;
  }
  const match = /^(https?):\/\/([^/?#\\]+)\/?$/i.exec(value);
  if (!match) return null;
  const scheme = match[1];
  const authority = match[2];
  if (!scheme || !authority) return null;
  const rawHostPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (!hostPortPattern.test(rawHostPort)) return null;
  const separator = rawHostPort.lastIndexOf(":");
  const rawHost = rawHostPort.slice(0, separator);
  const port = Number(rawHostPort.slice(separator + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== `${scheme.toLowerCase()}:` ||
      url.hostname.toLowerCase() !== rawHost.toLowerCase() ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      return null;
    return `${url.hostname.toLowerCase()}:${port}`;
  } catch {
    return null;
  }
}

/** An HTTP CONNECT proxy, not a replacement Gemini API origin. */
export const googleProxyEnvSchema = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z
    .string()
    .refine(
      (value) => proxyDestination(value) !== null,
      "GOOGLE_API_PROXY must be an http(s) proxy URL with an explicit port and no path, query or fragment",
    )
    .optional(),
);

/** Instance-approved egress destinations; never supplied by a workspace. */
export const googleProxyAllowlistSchema = z
  .string()
  .default("")
  .refine(
    (value) => value === "" || value.split(",").every((part) => hostPortPattern.test(part.trim())),
    "GOOGLE_PROXY_ALLOWED_HOSTS must be comma-separated host:port entries",
  );

function hostPort(proxyUrl: string): string {
  const destination = proxyDestination(proxyUrl);
  if (!destination) throw new PermanentError("Invalid Google proxy URL");
  return destination;
}

/** Reject arbitrary tenant-directed egress, including private-network and rebinding targets. */
export function isAllowedGoogleProxy(proxyUrl: string): boolean {
  if (!googleProxyEnvSchema.safeParse(proxyUrl).success) return false;
  const approved = googleProxyAllowlistSchema
    .parse(process.env.GOOGLE_PROXY_ALLOWED_HOSTS)
    .split(",")
    .map((value) => value.trim().toLowerCase());
  const fallback = googleProxyEnvSchema.safeParse(process.env.GOOGLE_API_PROXY);
  if (fallback.success && fallback.data) approved.push(hostPort(fallback.data));
  return approved.includes(hostPort(proxyUrl));
}

// Bound retained credentials and sockets across proxy rotations and workspaces.
const MAX_CACHED_AGENTS = 32;
const agents = new Map<string, ProxyAgent>();

/** Keep the proxy URL and its optional credentials entirely in the server process. */
export async function googleProxyFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
  orgProxyUrl?: string,
): Promise<Response> {
  const url = orgProxyUrl ?? googleProxyEnvSchema.parse(process.env.GOOGLE_API_PROXY);
  if (!url) return fetch(input, init);
  if (orgProxyUrl && !isAllowedGoogleProxy(orgProxyUrl)) {
    throw new PermanentError("Google proxy destination is not approved by the instance operator");
  }
  // Node's fetch accepts undici's dispatcher extension. The DOM RequestInit
  // type omits it, but the same dispatcher also drives @ai-sdk/google's fetch.
  try {
    // The organization-specific URL is captured in the caller's fetch function;
    // one global mutable selection could send a different org through this proxy.
    let agent = agents.get(url);
    if (!agent) {
      agent = new ProxyAgent(url);
      agents.set(url, agent);
      if (agents.size > MAX_CACHED_AGENTS) {
        const oldest = agents.entries().next().value;
        if (oldest) {
          agents.delete(oldest[0]);
          // close waits for in-flight fetches to release the connection.
          void oldest[1].close().catch(() => {});
        }
      }
    } else {
      agents.delete(url);
      agents.set(url, agent);
    }
    return await fetch(input, { ...init, dispatcher: agent } as RequestInit);
  } catch {
    // A transport exception can carry the proxy URL and userinfo. It also
    // might follow an upstream charge, so callers keep their existing ledger
    // and ambiguity policies, while jobs may retry a temporary proxy outage.
    throw new TransientError("Gemini proxy transport failed");
  }
}

/** Bind a credential's proxy to one request path without changing process state. */
export function googleFetchForProxy(proxyUrl?: string): typeof fetch {
  return (input, init) => googleProxyFetch(input, init, proxyUrl);
}
