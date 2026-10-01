import {
  CONTENT_STATUSES,
  idempotencyKeySchema,
  PUBLICATION_OPERATION_FILTERS,
  type PublicationOperationFilter,
  type PublicContentDetailV2,
  type PublicContentSummaryV2,
  type PublicDraftCreate,
  type PublicPublication,
  type PublicRunCreate,
  publicContentDetailV2Schema,
  publicContentListQuerySchema,
  publicContentListV2Schema,
  publicDraftCreateResultSchema,
  publicDraftCreateSchema,
  publicPublicationSchema,
  publicRunCreateResultSchema,
  publicRunCreateSchema,
  publicRunStatusSchema,
} from "@pubrick/shared";
import { z } from "zod";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_CURSOR_LENGTH = 4096;
const REQUEST_TIMEOUT_MS = 10_000;

export const contentStatusSchema = z.enum(CONTENT_STATUSES);

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
export type PublicationListOptions = {
  brandId: string;
  filter?: PublicationOperationFilter;
  limit?: number;
  cursor?: string;
};
export type PublicationListPage = { items: PublicPublication[]; nextCursor: string | null };
export const publicationFilterSchema = z.enum(PUBLICATION_OPERATION_FILTERS);

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): {
  baseUrl: URL;
  apiKey: string;
  publicationApiKey?: string;
  apiVersion: "v1" | "v2";
  contentCreateApiKey?: string;
  generationApiKey?: string;
} {
  if (!env.PUBRICK_API_BASE_URL) {
    throw new PublicApiError("PUBRICK_API_BASE_URL is required.");
  }
  const baseUrl = validateBaseUrl(env.PUBRICK_API_BASE_URL);
  const apiKey = env.PUBRICK_API_KEY;
  if (!apiKey || !/^[A-Za-z0-9._~-]+$/.test(apiKey)) {
    throw new PublicApiError("PUBRICK_API_KEY is required and must be a single-line Bearer key.");
  }
  const publicationApiKey = env.PUBRICK_PUBLICATIONS_API_KEY;
  if (publicationApiKey !== undefined && !/^[A-Za-z0-9._~-]+$/.test(publicationApiKey)) {
    throw new PublicApiError("PUBRICK_PUBLICATIONS_API_KEY must be a single-line Bearer key.");
  }
  const apiVersion = env.PUBRICK_API_VERSION ?? "v1";
  if (apiVersion !== "v1" && apiVersion !== "v2")
    throw new PublicApiError("PUBRICK_API_VERSION must be v1 or v2.");
  const contentCreateApiKey = env.PUBRICK_CONTENT_CREATE_API_KEY;
  const generationApiKey = env.PUBRICK_GENERATION_API_KEY;
  for (const [name, value] of [
    ["PUBRICK_CONTENT_CREATE_API_KEY", contentCreateApiKey],
    ["PUBRICK_GENERATION_API_KEY", generationApiKey],
  ]) {
    if (value !== undefined && !/^[A-Za-z0-9._~-]+$/.test(value))
      throw new PublicApiError(`${name} must be a single-line Bearer key.`);
    if (value !== undefined && apiVersion !== "v2")
      throw new PublicApiError("Write keys require explicit PUBRICK_API_VERSION=v2.");
  }
  return {
    baseUrl,
    apiKey,
    apiVersion,
    ...(publicationApiKey === undefined ? {} : { publicationApiKey }),
    ...(contentCreateApiKey === undefined ? {} : { contentCreateApiKey }),
    ...(generationApiKey === undefined ? {} : { generationApiKey }),
  };
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

async function request(
  config: { baseUrl: URL; apiKey: string },
  fetcher: typeof fetch,
  path: string,
  query?: URLSearchParams,
): Promise<Response> {
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

async function parseResponse(response: Response, publication = false): Promise<unknown> {
  if (response.status === 401 || response.status === 403) {
    throw new PublicApiError(
      publication
        ? "Pubrick denied the publication API key. Check its value and publications:read scope."
        : "Pubrick denied the API key. Check its value and content:read scope.",
    );
  }
  if (response.status === 404) {
    throw new PublicApiError(
      publication
        ? "Brand was not found in this key's organization."
        : "Content was not found in this key's organization.",
    );
  }
  if (response.status === 400) {
    throw new PublicApiError(
      publication
        ? "Pubrick rejected the publication request or cursor."
        : "Pubrick rejected the content request or cursor.",
    );
  }
  if (response.status === 429) {
    throw new PublicApiError("Pubrick is rate limiting requests. Retry later.");
  }
  if (!response.ok) {
    throw new PublicApiError("Pubrick could not complete the request. Retry later.");
  }
  return readBoundedJson(response);
}

function nextCursor(response: Response): string | null {
  const cursor = response.headers.get("x-next-cursor");
  if (cursor && cursor.length > MAX_CURSOR_LENGTH) {
    throw new PublicApiError("Pubrick returned an invalid pagination cursor.");
  }
  return cursor || null;
}

export function createPublicContentClient(
  config: { baseUrl: URL; apiKey: string; apiVersion?: "v1" | "v2" },
  fetcher: typeof fetch = fetch,
) {
  const version = config.apiVersion ?? "v1";
  return {
    async list(
      options: ListOptions = {},
    ): Promise<{ items: (ContentSummary | PublicContentSummaryV2)[]; nextCursor: string | null }> {
      const query = new URLSearchParams();
      if (options.status) query.set("status", options.status);
      if (options.limit !== undefined) query.set("limit", String(options.limit));
      if (options.cursor) query.set("cursor", options.cursor);
      if (version === "v2" && !publicContentListQuerySchema.safeParse(options).success)
        throw new PublicApiError("Invalid content list options.");
      const response = await request(config, fetcher, `api/${version}/content`, query);
      const raw = await parseResponse(response);
      if (version === "v2") {
        const result = publicContentListV2Schema.safeParse(raw);
        if (
          !result.success ||
          result.data.rows.length > 200 ||
          (result.data.nextCursor?.length ?? 0) > 512
        )
          throw new PublicApiError("Pubrick returned an invalid content list.");
        return { items: result.data.rows, nextCursor: result.data.nextCursor };
      }
      const parsed = z.array(summarySchema).max(200).safeParse(raw);
      if (!parsed.success) throw new PublicApiError("Pubrick returned an invalid content list.");
      return { items: parsed.data, nextCursor: nextCursor(response) };
    },
    async get(id: string): Promise<ContentDetail | PublicContentDetailV2> {
      const response = await request(
        config,
        fetcher,
        `api/${version}/content/${encodeURIComponent(id)}`,
      );
      const raw = await parseResponse(response);
      const parsed = (version === "v2" ? publicContentDetailV2Schema : detailSchema).safeParse(raw);
      if (!parsed.success) throw new PublicApiError("Pubrick returned an invalid content item.");
      return parsed.data;
    },
  };
}

export function createPublicPublicationClient(
  config: { baseUrl: URL; apiKey: string },
  fetcher: typeof fetch = fetch,
) {
  return {
    async list(options: PublicationListOptions): Promise<PublicationListPage> {
      const query = new URLSearchParams();
      if (options.filter) query.set("filter", options.filter);
      if (options.limit !== undefined) query.set("limit", String(options.limit));
      if (options.cursor) query.set("cursor", options.cursor);
      const response = await request(
        config,
        fetcher,
        `api/v1/brands/${encodeURIComponent(options.brandId)}/publications`,
        query,
      );
      const raw = await parseResponse(response, true);
      const parsed = z.array(publicPublicationSchema).max(100).safeParse(raw);
      if (!parsed.success)
        throw new PublicApiError("Pubrick returned an invalid publication list.");
      return { items: parsed.data, nextCursor: nextCursor(response) };
    },
  };
}

const UNKNOWN_OUTCOME =
  "The write outcome is unknown. Replay the exact same payload with the SAME idempotency key; do not create a new key.";
type ClientConfig = { baseUrl: URL; apiKey: string };
const WRITE_REFUSALS: Record<string, string> = {
  idempotency_conflict:
    "This idempotency key was used for a different payload. Restore the original payload.",
  public_result_gone:
    "The original result was deleted. This operation cannot create another result.",
  public_operation_capacity:
    "This workspace has reached its lifetime operation capacity. Contact the operator.",
};
async function writeRequest<T>(
  config: ClientConfig,
  fetcher: typeof fetch,
  path: string,
  body: unknown,
  key: string,
  schema: z.ZodType<T>,
): Promise<T> {
  if (!idempotencyKeySchema.safeParse(key).success)
    throw new PublicApiError(
      "Invalid idempotency key; use 8–128 ASCII letters, digits, periods, underscores or hyphens.",
    );
  const encoded = JSON.stringify(body);
  if (Buffer.byteLength(encoded, "utf8") > 1024 * 1024)
    throw new PublicApiError("Request exceeds the 1 MiB JSON limit.");
  let response: Response;
  try {
    response = await fetcher(new URL(path, config.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: encoded,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new PublicApiError(UNKNOWN_OUTCOME);
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new PublicApiError(
        "Pubrick denied the dedicated write key or operation. Check its scope and workspace.",
      );
    if (response.status === 429)
      throw new PublicApiError(
        "Pubrick is rate limiting requests. Retry later with the SAME idempotency key and payload.",
      );
    let raw: unknown;
    try {
      raw = await readBoundedJson(response);
    } catch {
      throw new PublicApiError(UNKNOWN_OUTCOME);
    }
    const code = raw && typeof raw === "object" && "code" in raw ? raw.code : undefined;
    if (typeof code === "string" && WRITE_REFUSALS[code])
      throw new PublicApiError(WRITE_REFUSALS[code]);
    if (
      response.status === 400 ||
      response.status === 404 ||
      response.status === 402 ||
      response.status === 409
    )
      throw new PublicApiError(
        "Pubrick refused the request. Check the input, targets, AI settings and workspace subscription before retrying with the SAME key and payload.",
      );
    throw new PublicApiError(UNKNOWN_OUTCOME);
  }
  try {
    const parsed = schema.safeParse(await readBoundedJson(response));
    if (!parsed.success) throw new PublicApiError(UNKNOWN_OUTCOME);
    return parsed.data;
  } catch {
    throw new PublicApiError(UNKNOWN_OUTCOME);
  }
}
export function createPublicDraftWriteClient(config: ClientConfig, fetcher: typeof fetch = fetch) {
  return {
    create(data: PublicDraftCreate, idempotencyKey: string) {
      const parsed = publicDraftCreateSchema.safeParse(data);
      if (!parsed.success) throw new PublicApiError("Invalid draft input.");
      return writeRequest(
        config,
        fetcher,
        "api/v2/content",
        parsed.data,
        idempotencyKey,
        publicDraftCreateResultSchema,
      );
    },
  };
}
export function createPublicGenerationClient(config: ClientConfig, fetcher: typeof fetch = fetch) {
  return {
    create(data: PublicRunCreate, idempotencyKey: string) {
      const parsed = publicRunCreateSchema.safeParse(data);
      if (!parsed.success)
        throw new PublicApiError("Invalid generation input or explicit paid consent.");
      return writeRequest(
        config,
        fetcher,
        "api/v2/runs",
        parsed.data,
        idempotencyKey,
        publicRunCreateResultSchema,
      );
    },
    async get(id: string) {
      if (!z.uuid().safeParse(id).success) throw new PublicApiError("Invalid run UUID.");
      const response = await request(config, fetcher, `api/v2/runs/${encodeURIComponent(id)}`);
      if (response.status === 401 || response.status === 403)
        throw new PublicApiError(
          "Pubrick denied the generation key. Check its generation:create scope.",
        );
      if (response.status === 404)
        throw new PublicApiError("Run was not found in this key's organization.");
      const parsed = publicRunStatusSchema.safeParse(await parseResponse(response));
      if (!parsed.success) throw new PublicApiError("Pubrick returned an invalid run status.");
      return parsed.data;
    },
  };
}
