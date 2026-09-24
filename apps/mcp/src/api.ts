import { z } from "zod";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CURSOR_LENGTH = 4096;
const REQUEST_TIMEOUT_MS = 10_000;

export const contentStatusSchema = z.enum([
  "draft",
  "approved",
  "partially_published",
  "rejected",
  "published",
  "failed",
]);

const summarySchema = z.object({
  id: z.uuid(),
  brandId: z.uuid(),
  title: z.string().nullable(),
  status: contentStatusSchema,
  origin: z.enum(["ai", "human"]),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
});

const detailSchema = summarySchema.extend({ body: z.string() });

export type ContentSummary = z.infer<typeof summarySchema>;
export type ContentDetail = z.infer<typeof detailSchema>;
export type ContentStatus = z.infer<typeof contentStatusSchema>;
export type ListOptions = { status?: ContentStatus; limit?: number; cursor?: string };
export type ListPage = { items: ContentSummary[]; nextCursor: string | null };

export class PublicApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicApiError";
  }
}

/** The configured URL is the Pubrick instance root, including its optional mount path. */
export function validateBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PublicApiError("PUBRICK_API_BASE_URL must be an absolute URL.");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new PublicApiError(
      "PUBRICK_API_BASE_URL must use HTTPS (or loopback HTTP) without credentials, query, or fragment.",
    );
  }
  // Append the fixed API path below any self-hosted reverse-proxy mount path.
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): { baseUrl: URL; apiKey: string } {
  if (!env.PUBRICK_API_BASE_URL) {
    throw new PublicApiError("PUBRICK_API_BASE_URL is required.");
  }
  const baseUrl = validateBaseUrl(env.PUBRICK_API_BASE_URL);
  const apiKey = env.PUBRICK_API_KEY;
  if (!apiKey || !/^[A-Za-z0-9._~-]+$/.test(apiKey)) {
    throw new PublicApiError("PUBRICK_API_KEY is required and must be a single-line Bearer key.");
  }
  return { baseUrl, apiKey };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new PublicApiError("Pubrick returned a response that is too large.");
  }
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new PublicApiError("Pubrick returned an unexpected response format.");
  }
  if (!response.body) throw new PublicApiError("Pubrick returned an empty response.");

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new PublicApiError("Pubrick returned a response that is too large.");
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = Buffer.concat(chunks, bytes).toString("utf8");
  try {
    return JSON.parse(body);
  } catch {
    throw new PublicApiError("Pubrick returned invalid JSON.");
  }
}

export function createPublicContentClient(
  config: { baseUrl: URL; apiKey: string },
  fetcher: typeof fetch = fetch,
) {
  async function request(path: string, query?: URLSearchParams): Promise<Response> {
    const url = new URL(path, config.baseUrl);
    if (query) url.search = query.toString();
    try {
      return await fetcher(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${config.apiKey}`, Accept: "application/json" },
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // Fetch errors can include the URL or headers. Do not relay them to an MCP client.
      throw new PublicApiError("Could not reach Pubrick. Check the API URL and connection.");
    }
  }

  async function parseResponse(response: Response): Promise<unknown> {
    if (response.status === 401 || response.status === 403) {
      throw new PublicApiError(
        "Pubrick denied the API key. Check its value and content:read scope.",
      );
    }
    if (response.status === 404) {
      throw new PublicApiError("Content was not found in this key's organization.");
    }
    if (response.status === 400) {
      throw new PublicApiError("Pubrick rejected the content request or cursor.");
    }
    if (response.status === 429) {
      throw new PublicApiError("Pubrick is rate limiting requests. Retry later.");
    }
    if (!response.ok) {
      throw new PublicApiError("Pubrick could not complete the request. Retry later.");
    }
    return readBoundedJson(response);
  }

  return {
    async list(options: ListOptions = {}): Promise<ListPage> {
      const query = new URLSearchParams();
      if (options.status) query.set("status", options.status);
      if (options.limit !== undefined) query.set("limit", String(options.limit));
      if (options.cursor) query.set("cursor", options.cursor);
      const response = await request("api/v1/content", query);
      const raw = await parseResponse(response);
      const parsed = z.array(summarySchema).max(200).safeParse(raw);
      if (!parsed.success) throw new PublicApiError("Pubrick returned an invalid content list.");
      const nextCursor = response.headers.get("x-next-cursor");
      if (nextCursor && nextCursor.length > MAX_CURSOR_LENGTH) {
        throw new PublicApiError("Pubrick returned an invalid pagination cursor.");
      }
      return { items: parsed.data, nextCursor: nextCursor || null };
    },
    async get(id: string): Promise<ContentDetail> {
      const response = await request(`api/v1/content/${encodeURIComponent(id)}`);
      const raw = await parseResponse(response);
      const parsed = detailSchema.safeParse(raw);
      if (!parsed.success) throw new PublicApiError("Pubrick returned an invalid content item.");
      return parsed.data;
    },
  };
}
