import { Readability } from "@mozilla/readability";
import { BadRequestException, Injectable } from "@nestjs/common";
import {
  MAX_SOURCE_TEXT_LENGTH,
  refusalBody,
  type SourceExtractionResponse,
} from "@pubrick/shared";
import { guardedFetchText, isGuardedFetchError } from "guarded-fetch";
import { JSDOM } from "jsdom";

const MAX_HTML_BYTES = 2 * 1024 * 1024;

type FetchText = typeof guardedFetchText;

function cleanText(value: string): string {
  return value
    .replaceAll("\u0000", "")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/\n[\n ]*\n[\n ]*\n/g, "\n\n")
    .trim();
}

function boundedMaterial(text: string): { material: string; truncated: boolean } {
  let material = text.slice(0, MAX_SOURCE_TEXT_LENGTH);
  // A UTF-16 cut between a surrogate pair cannot be stored losslessly as JSON.
  const last = material.charCodeAt(material.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) material = material.slice(0, -1);
  return { material, truncated: text.length > material.length };
}

/** Fetch only public HTTP(S) pages; return a preview, never persist or run AI. */
export async function extractSource(
  url: string,
  fetchText: FetchText = guardedFetchText,
): Promise<SourceExtractionResponse> {
  let html: string;
  try {
    html = await fetchText(url, {
      maxResponseBytes: MAX_HTML_BYTES,
      timeoutMs: 10_000,
      maxRedirects: 5,
      throwOnHttpError: true,
      opaqueErrors: true,
    });
  } catch (error) {
    const tooLarge = isGuardedFetchError(error) && error.code === "response_too_large";
    const code = tooLarge ? "source_response_too_large" : "source_fetch_failed";
    throw new BadRequestException(
      refusalBody(
        400,
        code,
        tooLarge ? "The source page is too large" : "The source could not be fetched",
      ),
    );
  }

  // jsdom does not execute scripts or fetch subresources by default. Readability
  // extracts the article; only textContent enters our response, never HTML.
  let dom: JSDOM;
  try {
    dom = new JSDOM(html, { url });
  } catch {
    throw new BadRequestException(
      refusalBody(400, "source_unreadable", "The page contains no extractable article text"),
    );
  }
  try {
    const article = new Readability(dom.window.document, { charThreshold: 200 }).parse();
    const title = cleanText(article?.title ?? "").slice(0, 500);
    const body = cleanText(article?.textContent ?? "");
    if (body.length < 80) {
      throw new BadRequestException(
        refusalBody(400, "source_unreadable", "The page contains no extractable article text"),
      );
    }
    const combined = title ? `${title}\n\n${body}` : body;
    return { title, ...boundedMaterial(combined) };
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException(
      refusalBody(400, "source_unreadable", "The page contains no extractable article text"),
    );
  } finally {
    dom.window.close();
  }
}

@Injectable()
export class SourceExtractionService {
  extract(url: string) {
    return extractSource(url);
  }
}
