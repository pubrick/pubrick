import { XMLParser, XMLValidator } from "fast-xml-parser";

const ENDPOINT = "https://searchapi.api.cloud.yandex.net/v2/web/search";
const MAX_QUERY_CHARACTERS = 400;
const MAX_HITS = 5;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_XML_BYTES = 786_432;
const DEFAULT_TIMEOUT_MS = 8_000;

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  signal?: AbortSignal;
}

export interface YandexWebSearchConfig {
  apiKey: string;
  folderId: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  searchType?: "SEARCH_TYPE_RU" | "SEARCH_TYPE_COM";
  region?: string;
  l10n?: "LOCALIZATION_RU" | "LOCALIZATION_EN";
}

export class SearchProviderError extends Error {
  constructor(
    public readonly code: "invalid_query" | "aborted" | "timeout" | "provider" | "response",
    message: string,
  ) {
    super(message);
    this.name = "SearchProviderError";
  }
}

function responseError(): SearchProviderError {
  return new SearchProviderError("response", "Search provider returned an invalid response");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function entries(value: unknown): unknown[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function plainText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value !== "object" || value === null) return "";
  if (Array.isArray(value)) return value.map(plainText).filter(Boolean).join(" ");
  return Object.values(value).map(plainText).filter(Boolean).join(" ");
}

function compactText(value: unknown, limit: number): string {
  return plainText(value).replace(/\s+/g, " ").trim().slice(0, limit);
}

function validWebUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function parseYandexXml(xml: string): SearchHit[] {
  // Search output is untrusted. Reject DTDs rather than allowing entity expansion.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(xml) || XMLValidator.validate(xml) !== true) {
    throw responseError();
  }
  let root: Record<string, unknown> | null;
  try {
    root = asRecord(
      new XMLParser({
        ignoreAttributes: true,
        parseTagValue: false,
        processEntities: true,
      }).parse(xml),
    );
  } catch {
    throw responseError();
  }
  const response = asRecord(asRecord(root?.yandexsearch)?.response);
  if (!response) throw responseError();
  if (response.error !== undefined) throw responseError();
  const results = asRecord(response.results);
  const hits: SearchHit[] = [];
  for (const groupingValue of entries(results?.grouping)) {
    const grouping = asRecord(groupingValue);
    for (const groupValue of entries(grouping?.group)) {
      const group = asRecord(groupValue);
      for (const docValue of entries(group?.doc)) {
        const doc = asRecord(docValue);
        if (!doc) continue;
        const url = validWebUrl(doc.url);
        const title = compactText(doc.title, 300);
        if (!url || !title) continue;
        const passages = asRecord(doc.passages);
        hits.push({ title, url, snippet: compactText(passages?.passage, 500) });
        if (hits.length === MAX_HITS) return hits;
      }
    }
  }
  return hits;
}

async function readLimited(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (declaredLength > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw responseError();
  }
  if (!response.body) throw responseError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw responseError();
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
    if (size > MAX_RESPONSE_BYTES) await response.body.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

export class YandexWebSearchClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: YandexWebSearchConfig) {
    if (!config.apiKey.trim() || !config.folderId.trim() || config.folderId.length > 50) {
      throw new SearchProviderError("provider", "Search provider is not configured");
    }
    if (
      config.timeoutMs !== undefined &&
      (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 30_000)
    ) {
      throw new SearchProviderError("provider", "Search provider timeout is invalid");
    }
    this.fetchImpl = config.fetch ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchHit[]> {
    const normalized = query.trim();
    if (!normalized || Array.from(normalized).length > MAX_QUERY_CHARACTERS) {
      throw new SearchProviderError(
        "invalid_query",
        "Search query must contain 1 to 400 characters",
      );
    }
    if (options.signal?.aborted) throw new SearchProviderError("aborted", "Search was cancelled");

    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let abortListener: (() => void) | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new SearchProviderError("timeout", "Search provider timed out"));
      }, this.timeoutMs);
    });
    const cancelled = new Promise<never>((_, reject) => {
      abortListener = () => {
        controller.abort();
        reject(new SearchProviderError("aborted", "Search was cancelled"));
      };
      options.signal?.addEventListener("abort", abortListener, { once: true });
    });
    try {
      return await Promise.race([this.request(normalized, controller.signal), timeout, cancelled]);
    } catch (error) {
      if (error instanceof SearchProviderError) throw error;
      throw new SearchProviderError("provider", "Search provider request failed");
    } finally {
      clearTimeout(timeoutId);
      if (abortListener) options.signal?.removeEventListener("abort", abortListener);
      controller.abort();
    }
  }

  private async request(query: string, signal: AbortSignal): Promise<SearchHit[]> {
    const searchType = this.config.searchType ?? "SEARCH_TYPE_RU";
    const body = {
      folderId: this.config.folderId,
      query: { searchType, queryText: query, familyMode: "FAMILY_MODE_MODERATE" },
      groupSpec: { groupMode: "GROUP_MODE_FLAT", groupsOnPage: "5", docsInGroup: "1" },
      maxPassages: "1",
      ...(searchType === "SEARCH_TYPE_RU" ? { region: this.config.region ?? "225" } : {}),
      l10n:
        this.config.l10n ??
        (searchType === "SEARCH_TYPE_RU" ? "LOCALIZATION_RU" : "LOCALIZATION_EN"),
      responseFormat: "FORMAT_XML",
    };
    const response = await this.fetchImpl(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) {
      // Provider bodies and HTTP status text can include sensitive query details.
      throw new SearchProviderError("provider", "Search provider request failed");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(await readLimited(response));
    } catch (error) {
      if (error instanceof SearchProviderError) throw error;
      throw responseError();
    }
    const rawData = asRecord(payload)?.rawData;
    if (
      typeof rawData !== "string" ||
      rawData.length === 0 ||
      rawData.length > MAX_RESPONSE_BYTES ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(rawData)
    ) {
      throw responseError();
    }
    const decoded = Buffer.from(rawData, "base64");
    if (decoded.byteLength > MAX_XML_BYTES || decoded.toString("base64") !== rawData) {
      throw responseError();
    }
    let xml: string;
    try {
      xml = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    } catch {
      throw responseError();
    }
    return parseYandexXml(xml);
  }
}
