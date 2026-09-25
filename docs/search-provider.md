# Search provider

`@pubrick/search` is a bounded client for the synchronous [Yandex Web Search API v2](https://aistudio.yandex.ru/en/docs/search-api/api-ref/WebSearch/search). It sends `POST /v2/web/search` using an API key and folder ID supplied by the caller. The provider returns Base64-encoded XML in `rawData`. The client normalizes up to five HTTP(S) results into `{ title, url, snippet }`; it does not open the result pages or verify a claim by itself.

The query limit is 400 characters. Each call requests one page with at most five groups, one document per group and one passage. The client times out after eight seconds by default, caps the HTTP response at 1 MiB and the decoded XML at 768 KiB, rejects DTDs, and returns error codes without provider response bodies or credentials. A caller may supply a shorter timeout, custom `fetch`, and an `AbortSignal`. The default search is Russian (region `225`); `SEARCH_TYPE_COM` uses international search and English localization without a region.

Use this only behind an explicit, metered workflow: a search request may incur Yandex Cloud charges even when it returns no results. The package intentionally does not store keys, schedule searches, fetch search hits, or decide whether evidence supports a claim. Those remain application-level responsibilities. Tests use mocked `fetch` and never call Yandex.
