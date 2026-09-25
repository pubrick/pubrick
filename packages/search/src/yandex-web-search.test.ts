import { describe, expect, it, vi } from "vitest";
import { parseYandexXml, SearchProviderError, YandexWebSearchClient } from "./yandex-web-search.js";

const xml = (documents: string) =>
  `<?xml version="1.0"?><yandexsearch><response><results><grouping>${documents}</grouping></results></response></yandexsearch>`;
const doc = (title: string, url: string, passage = "Evidence") =>
  `<group><doc><title>${title}</title><url>${url}</url><passages><passage>${passage}</passage></passages></doc></group>`;
const searchResponse = (body: string) =>
  new Response(JSON.stringify({ rawData: Buffer.from(body).toString("base64") }), {
    headers: { "Content-Type": "application/json" },
  });
const client = (fetchImpl: typeof fetch, timeoutMs = 1000) =>
  new YandexWebSearchClient({
    apiKey: "secret-key",
    folderId: "folder-id",
    fetch: fetchImpl,
    timeoutMs,
  });

describe("YandexWebSearchClient", () => {
  it("sends the documented v2 XML request and normalizes only five hits", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        searchResponse(
          xml(
            Array.from({ length: 7 }, (_, i) => doc(`Title ${i}`, `https://example.org/${i}`)).join(
              "",
            ),
          ),
        ),
      );
    const hits = await client(fetchImpl).search("  verified claim  ");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://searchapi.api.cloud.yandex.net/v2/web/search");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({
      Authorization: "Api-Key secret-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init?.body))).toEqual({
      folderId: "folder-id",
      query: {
        searchType: "SEARCH_TYPE_RU",
        queryText: "verified claim",
        familyMode: "FAMILY_MODE_MODERATE",
      },
      groupSpec: { groupMode: "GROUP_MODE_FLAT", groupsOnPage: "5", docsInGroup: "1" },
      maxPassages: "1",
      region: "225",
      l10n: "LOCALIZATION_RU",
      responseFormat: "FORMAT_XML",
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(hits).toHaveLength(5);
    expect(hits[0]).toEqual({
      title: "Title 0",
      url: "https://example.org/0",
      snippet: "Evidence",
    });
  });

  it("supports international search without an unsupported region", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(searchResponse(xml("")));
    const search = new YandexWebSearchClient({
      apiKey: "secret-key",
      folderId: "folder-id",
      fetch: fetchImpl,
      searchType: "SEARCH_TYPE_COM",
    });
    expect(await search.search("claim")).toEqual([]);
    const body = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body));
    expect(body.query.searchType).toBe("SEARCH_TYPE_COM");
    expect(body.l10n).toBe("LOCALIZATION_EN");
    expect(body).not.toHaveProperty("region");
  });

  it("rejects empty and overlength queries before making a paid request", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const search = client(fetchImpl);
    await expect(search.search("  ")).rejects.toMatchObject({ code: "invalid_query" });
    await expect(search.search("x".repeat(401))).rejects.toMatchObject({ code: "invalid_query" });
    expect(fetchImpl).not.toHaveBeenCalled();
    fetchImpl.mockResolvedValue(searchResponse(xml("")));
    await expect(search.search("x".repeat(400))).resolves.toEqual([]);
  });

  it("rejects malformed XML, invalid base64 and unexpected JSON", async () => {
    for (const response of [
      searchResponse("<yandexsearch><response>"),
      searchResponse("<wrong/>"),
      searchResponse("<yandexsearch><response><error>Denied</error></response></yandexsearch>"),
      new Response(JSON.stringify({ rawData: "!?" })),
      new Response(JSON.stringify({ rawData: "abc" })),
      new Response("not json"),
    ]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response);
      await expect(client(fetchImpl).search("claim")).rejects.toMatchObject({ code: "response" });
    }
  });

  it("rejects DTDs and filters non-web or credential-bearing URLs", () => {
    expect(() => parseYandexXml(`<!DOCTYPE foo [<!ENTITY x "secret">]>${xml("")}`)).toThrow(
      SearchProviderError,
    );
    expect(
      parseYandexXml(
        xml(
          [
            doc("Unsafe", "javascript:alert(1)"),
            doc("Private", "https://user:pass@example.org/"),
            doc("Valid", "https://example.org/a?b=1&amp;c=2", "A &amp; B"),
            "<group><doc><url>https://example.org/no-title</url></doc></group>",
          ].join(""),
        ),
      ),
    ).toEqual([{ title: "Valid", url: "https://example.org/a?b=1&c=2", snippet: "A & B" }]);
  });

  it("rejects both declared and streaming oversized responses", async () => {
    const advertised = new Response("{}", { headers: { "Content-Length": "1048577" } });
    await expect(
      client(vi.fn<typeof fetch>().mockResolvedValue(advertised)).search("claim"),
    ).rejects.toMatchObject({ code: "response" });
    const oversized = new Response("x".repeat(1_048_577));
    await expect(
      client(vi.fn<typeof fetch>().mockResolvedValue(oversized)).search("claim"),
    ).rejects.toMatchObject({ code: "response" });
  });

  it("times out and aborts even when a fetch mock ignores its signal", async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockImplementation(() => new Promise(() => undefined));
      const pending = client(fetchImpl, 100).search("claim");
      const rejection = expect(pending).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      expect(fetchImpl.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports caller cancellation and suppresses provider response details", async () => {
    const abort = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
    const pending = client(fetchImpl).search("claim", { signal: abort.signal });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    const refused = client(
      vi.fn<typeof fetch>().mockResolvedValue(new Response("secret-key leaked", { status: 403 })),
    );
    await expect(refused.search("claim")).rejects.toThrow("Search provider request failed");
    const failed = client(vi.fn<typeof fetch>().mockRejectedValue(new Error("secret-key leaked")));
    await expect(failed.search("claim")).rejects.toThrow("Search provider request failed");
  });
});
