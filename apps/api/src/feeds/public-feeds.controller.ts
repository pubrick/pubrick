import { Controller, Get, Header, Param, ParseUUIDPipe } from "@nestjs/common";
import { AllowAnonymous } from "@thallesp/nestjs-better-auth";
import { Feed } from "feed";
import { escape as escapeHtml } from "html-escaper";
import { env } from "../env";
import { FeedsRepository } from "./feeds.repository";

function articleUrl(orgId: string, token: string, id: string): string {
  const base = env.WEB_ORIGIN.replace(/\/$/, "");
  return `${base}/api/feeds/${encodeURIComponent(orgId)}/${token}/articles/${id}`;
}

function paragraphs(text: string): string {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/** XML 1.0 Char production; `feed` escapes markup but preserves forbidden scalars. */
function xmlSafe(text: string): string {
  return Array.from(text)
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      return (
        code === 0x9 ||
        code === 0xa ||
        code === 0xd ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        (code >= 0x10000 && code <= 0x10ffff)
      );
    })
    .join("");
}

/** The feed and its article links are intentionally public only after a member opts in. */
@Controller("feeds/:orgId/:token")
@AllowAnonymous()
export class PublicFeedsController {
  constructor(private readonly feeds: FeedsRepository) {}

  @Get("rss")
  @Header("Content-Type", "application/rss+xml; charset=utf-8")
  @Header("Cache-Control", "no-store")
  async rss(@Param("orgId") orgId: string, @Param("token") token: string) {
    const data = await this.feeds.publicFeed(orgId, token);
    const feed = new Feed({
      title: xmlSafe(data.brandName),
      description: xmlSafe(data.brandDescription ?? `${data.brandName} posts`),
      id: data.url,
      link: data.url,
      language: xmlSafe(data.language),
      feedLinks: { rss: data.url },
      generator: "Pubrick",
    });
    for (const entry of data.entries) {
      const url = articleUrl(orgId, token, entry.id);
      feed.addItem({
        id: url,
        link: url,
        title: xmlSafe(entry.title),
        date: entry.publishedAt,
        description: xmlSafe(entry.body.slice(0, 280)),
        content: paragraphs(xmlSafe(entry.body)),
      });
    }
    return feed.rss2();
  }

  @Get("articles/:entryId")
  @Header("Content-Type", "text/html; charset=utf-8")
  @Header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'")
  @Header("Cache-Control", "no-store")
  async article(
    @Param("orgId") orgId: string,
    @Param("token") token: string,
    @Param("entryId", ParseUUIDPipe) entryId: string,
  ) {
    const article = await this.feeds.publicArticle(orgId, token, entryId);
    return `<!doctype html><html lang="${escapeHtml(article.language)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(article.title)}</title><style>body{max-width:42rem;margin:3rem auto;padding:0 1.25rem;font:1.1rem/1.65 system-ui,sans-serif;color:#21201e}h1{line-height:1.2}small{color:#625e5a}</style></head><body><main><small>${escapeHtml(article.brandName)} · ${article.publishedAt.toISOString().slice(0, 10)}</small><h1>${escapeHtml(article.title)}</h1>${paragraphs(article.body)}</main></body></html>`;
  }
}
