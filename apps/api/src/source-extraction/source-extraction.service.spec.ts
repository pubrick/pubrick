import { BadRequestException } from "@nestjs/common";
import { MAX_SOURCE_TEXT_LENGTH } from "@pubrick/shared";
import { GuardedFetchError, type guardedFetchText } from "guarded-fetch";
import { describe, expect, it, vi } from "vitest";
import { extractSource } from "./source-extraction.service";

const URL = "https://example.com/blog/guide";

function fetcher(html: string) {
  return vi.fn(async () => html) as unknown as typeof guardedFetchText;
}

function article(body: string) {
  return `<html><head><title>A practical guide</title></head><body><article><h1>A practical guide</h1><p>${body}</p><script>secret()</script></article></body></html>`;
}

function responseOf(error: unknown) {
  expect(error).toBeInstanceOf(BadRequestException);
  return (error as BadRequestException).getResponse();
}

describe("source extraction preview", () => {
  it("extracts readable text from a public article, with no markup or script", async () => {
    const fetchText = fetcher(article("The guide explains the process. ".repeat(20)));
    const result = await extractSource(URL, fetchText);

    expect(result.title).toBe("A practical guide");
    expect(result.material).toContain("The guide explains the process.");
    expect(result.material).not.toContain("<article>");
    expect(result.material).not.toContain("secret()");
    expect(result.truncated).toBe(false);
    expect(fetchText).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({ maxResponseBytes: 2 * 1024 * 1024, opaqueErrors: true }),
    );
  });

  it("fits the run's source text limit and says when the preview was clipped", async () => {
    const result = await extractSource(URL, fetcher(article("A useful sentence. ".repeat(1000))));
    expect(result.material.length).toBeLessThanOrEqual(MAX_SOURCE_TEXT_LENGTH);
    expect(result.truncated).toBe(true);
  });

  it("refuses a page without article text and does not echo its HTML", async () => {
    const error = await extractSource(
      URL,
      fetcher("<html><body><nav>Only navigation</nav></body></html>"),
    ).catch((e: unknown) => e);
    expect(responseOf(error)).toMatchObject({ code: "source_unreadable" });
    expect(JSON.stringify(responseOf(error))).not.toContain("Only navigation");
  });

  it("keeps blocked URLs and oversized responses as distinct safe refusals", async () => {
    for (const [failure, code] of [
      [new GuardedFetchError("hostname_unsafe", "internal address"), "source_fetch_failed"],
      [new GuardedFetchError("response_too_large", "full response"), "source_response_too_large"],
    ] as const) {
      const reject = vi.fn(async () => {
        throw failure;
      }) as unknown as typeof guardedFetchText;
      const error = await extractSource(URL, reject).catch((e: unknown) => e);
      expect(responseOf(error)).toMatchObject({ code });
      expect(JSON.stringify(responseOf(error))).not.toContain(failure.message);
    }
  });
});
