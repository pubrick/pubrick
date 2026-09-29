import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { PermanentError, TransientError } from "@pubrick/shared";
import { ProxyAgent } from "undici";
import { z } from "zod";

const hostPortPattern = /^(?:[a-z0-9.-]+|\[[0-9a-f:]+\]):[0-9]{1,5}$/i;

function proxyDestination(value: string): string | null {
  // WHATWG URL treats a backslash as a path separator for http(s). Validate
  // the original syntax before using its canonical hostname for the public-IP check.
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

// Workspace owners can choose any public HTTP(S) forward proxy. Refuse
// non-public literal addresses at save time and resolve DNS through the same
// filter at each new socket: checking only when saving permits DNS rebinding.
const blockedV4 = new BlockList();
for (const [base, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blockedV4.addSubnet(base, prefix, "ipv4");

const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const blockedV6 = new BlockList();
for (const [base, prefix] of [
  ["2001::", 32],
  ["2001:10::", 28],
  ["2001:db8::", 32],
  ["2002::", 16],
] as const)
  blockedV6.addSubnet(base, prefix, "ipv6");

export function isPublicProxyAddress(address: string): boolean {
  const bare = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const family = isIP(bare);
  if (family === 4) return !blockedV4.check(bare, "ipv4");
  return family === 6 && globalV6.check(bare, "ipv6") && !blockedV6.check(bare, "ipv6");
}

/** Validate URL syntax and any literal address without requiring an allowlist. */
export function isAllowedGoogleProxy(proxyUrl: string): boolean {
  if (!googleProxyEnvSchema.safeParse(proxyUrl).success) return false;
  const hostname = new URL(proxyUrl).hostname;
  return isIP(hostname.replace(/^\[|\]$/g, "")) === 0 || isPublicProxyAddress(hostname);
}

/** Resolve only public addresses, passing the chosen IP to the socket itself. */
const publicProxyLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { all: true, family: options.family }, (error, addresses) => {
    if (error) return callback(error, options.all ? [] : "", 0);
    const publicAddresses = addresses.filter((entry: LookupAddress) =>
      isPublicProxyAddress(entry.address),
    );
    if (publicAddresses.length === 0) {
      return callback(new Error("Proxy destination is not public"), options.all ? [] : "", 0);
    }
    if (options.all) return callback(null, publicAddresses);
    const first = publicAddresses[0];
    if (first) callback(null, first.address, first.family);
  });
};

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
    throw new PermanentError("Invalid or non-public Google proxy destination");
  }
  // Node's fetch accepts undici's dispatcher extension. The DOM RequestInit
  // type omits it, but the same dispatcher also drives @ai-sdk/google's fetch.
  try {
    // The organization-specific URL is captured in the caller's fetch function;
    // one global mutable selection could send a different org through this proxy.
    let agent = agents.get(url);
    if (!agent) {
      agent = new ProxyAgent({ uri: url, proxyTls: { lookup: publicProxyLookup } });
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
