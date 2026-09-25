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
    expect(result.kind).toBe("article");
    expect(result.material).toContain("The guide explains the process.");
    expect(result.material).not.toContain("<article>");
    expect(result.material).not.toContain("secret()");
    expect(result.truncated).toBe(false);
    expect(fetchText).toHaveBeenCalledWith(
      URL,
      expect.objectContaining({ maxResponseBytes: 2 * 1024 * 1024, opaqueErrors: true }),
    );
  });

  it("uses article extraction for a public newsletter archive URL", async () => {
    const url = "https://newsletter.example.com/p/september-issue";
    const fetchText = fetcher(article("Newsletter issue details. ".repeat(20)));
    const result = await extractSource(url, fetchText);
    expect(result.kind).toBe("article");
    expect(result.material).toContain("Newsletter issue details.");
    expect(fetchText).toHaveBeenCalledWith(url, expect.any(Object));
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

  it("routes a YouTube watch link to captions without fetching its page as an article", async () => {
    const fetchText = fetcher(article("This should never be used. ".repeat(20)));
    const fetchVideo = vi.fn(async () => ({
      kind: "video" as const,
      title: "",
      material: "Actual caption text",
      truncated: false,
    }));
    expect(
      await extractSource("https://www.youtube.com/watch?v=dQw4w9WgXcQ", fetchText, fetchVideo),
    ).toEqual({ kind: "video", title: "", material: "Actual caption text", truncated: false });
    expect(fetchVideo).toHaveBeenCalledWith("dQw4w9WgXcQ");
    expect(fetchText).not.toHaveBeenCalled();
  });

  it("refuses a YouTube channel URL instead of trying article extraction", async () => {
    const fetchText = fetcher(article("This should never be used. ".repeat(20)));
    const error = await extractSource("https://youtube.com/@creator", fetchText).catch(
      (value: unknown) => value,
    );
    expect(responseOf(error)).toMatchObject({ code: "source_transcript_unavailable" });
    expect(fetchText).not.toHaveBeenCalled();
  });
});
