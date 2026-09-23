import { type AnyFeed, parseFeed } from "feedsmith";
import { guardedFetchText, isGuardedFetchError } from "guarded-fetch";
import { convert } from "html-to-text";

export type FeedItem = {
  title: string;
  summary: string;
  url: string;
  publishedAt: Date | null;
};

export class FeedFetchError extends Error {
  constructor(readonly code: "fetch_failed" | "invalid_feed" | "response_too_large") {
    super(code);
  }
}

function plain(value: string | undefined, max: number): string {
  return convert(value ?? "", { wordwrap: false })
    .replaceAll("\u0000", "")
    .trim()
    .slice(0, max);
}

function absoluteLink(value: string | undefined, feedUrl: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, feedUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    url.hash = "";
    const normalized = url.toString();
    return normalized.length <= 2048 ? normalized : null;
  } catch {
    return null;
  }
}

function date(value: string | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parseFeedItems(text: string, feedUrl: string): FeedItem[] {
  let parsed: AnyFeed<string>;
  try {
    parsed = parseFeed(text);
  } catch {
    throw new FeedFetchError("invalid_feed");
  }

  const raw: { title?: string; summary?: string; link?: string; published?: string }[] = [];
  if (parsed.format === "rss") {
    for (const item of parsed.feed.items ?? []) {
      raw.push({
        title: item.title,
        summary: item.description,
        link: item.link,
        published: item.pubDate,
      });
    }
  } else if (parsed.format === "atom") {
    for (const item of parsed.feed.entries ?? []) {
      raw.push({
        title: item.title?.value,
        summary: item.summary?.value ?? item.content?.value,
        link: item.links?.find((link) => !link.rel || link.rel === "alternate")?.href,
        published: item.published ?? item.updated,
      });
    }
  } else if (parsed.format === "rdf") {
    for (const item of parsed.feed.items ?? []) {
      raw.push({ title: item.title, summary: item.description, link: item.link });
    }
  } else {
    for (const item of parsed.feed.items ?? []) {
      raw.push({
        title: item.title,
        summary: item.summary ?? item.content_text ?? item.content_html,
        link: item.url ?? item.external_url,
        published: item.date_published,
      });
    }
  }

  return raw.slice(0, 50).flatMap((item) => {
    const url = absoluteLink(item.link, feedUrl);
    const title = plain(item.title, 500);
    if (!url || !title) return [];
    return [{ title, summary: plain(item.summary, 8000), url, publishedAt: date(item.published) }];
  });
}

/** The fetch library pins validated public IPs across DNS lookup and redirects. */
export async function fetchFeed(url: string): Promise<FeedItem[]> {
  try {
    const text = await guardedFetchText(url, {
      maxResponseBytes: 2 * 1024 * 1024,
      timeoutMs: 10_000,
      maxRedirects: 5,
      throwOnHttpError: true,
      opaqueErrors: true,
    });
    return parseFeedItems(text, url);
  } catch (error) {
    if (error instanceof FeedFetchError) throw error;
    if (isGuardedFetchError(error) && error.code === "response_too_large") {
      throw new FeedFetchError("response_too_large");
    }
    throw new FeedFetchError("fetch_failed");
  }
}
